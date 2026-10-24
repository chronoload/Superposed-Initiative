import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ejectCore, latestSession, mountCore, provisionCore } from "@superpose/agent-core";
import type { ProvisionedCore } from "@superpose/agent-core";
import { b64urlDecode, generateKeyPair } from "@superpose/protocol";
import { keyIdOfSecret } from "@superpose/quantum";
import { DEVICE_OPS, startSuite } from "@superpose/mobile-suite";
import type { MobileSuite } from "@superpose/mobile-suite";

import { createEmbody } from "./loop.ts";
import type { Embody, EmbodyEvent } from "./loop.ts";
import { saveProviderConfig } from "./provider.ts";

const PIN = "24681357";
const SUITE_ID = "suite_ab12cd34";

let dataDir = "";
let quantumKey: Uint8Array;
let core: ProvisionedCore;
let suite: MobileSuite | null = null;
const embodiments: Embody[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-embody-"));
  process.env.SUPERPOSE_DATA = dataDir;
  quantumKey = new Uint8Array(32).fill(5);
  core = await provisionCore({
    displayName: "embody-test",
    quantumKeyIds: [keyIdOfSecret(quantumKey)],
    pin: PIN,
    seed: new Uint8Array(32).fill(11),
  });
  mountCore(core.coreId);
});

afterEach(async () => {
  for (const embody of embodiments.splice(0)) embody.stop();
  if (suite !== null) await suite.close().catch(() => undefined);
  suite = null;
  delete process.env.SUPERPOSE_DATA;
  await rm(dataDir, { recursive: true, force: true });
});

async function bootSuite(): Promise<MobileSuite> {
  const pair = generateKeyPair(new Uint8Array(32).fill(23));
  const started = await startSuite({
    dataDir,
    suiteId: SUITE_ID,
    secretKey: pair.privateKey,
    quantumKey,
    port: 0,
    policy: { allow: { [core.coreId]: [...DEVICE_OPS] } },
  });
  started.registerCoreKey(core.coreId, core.manifest.keys.coreSigningPub);
  await started.publishIface();
  await started.publishGrant(core.coreId);
  suite = started;
  return started;
}

function bootEmbody(
  suiteUrl: string,
  options?: { pin?: string },
): { embody: Embody; events: EmbodyEvent[] } {
  const embody = createEmbody({
    coreId: core.coreId,
    pin: options?.pin ?? PIN,
    coreSecretKey: b64urlDecode(core.coreSecretKey),
    quantumKey,
    suiteUrl,
  });
  const events: EmbodyEvent[] = [];
  embody.onEvent((event) => events.push(event));
  embodiments.push(embody);
  return { embody, events };
}

function lifecycleStates(events: readonly EmbodyEvent[]): string[] {
  const states: string[] = [];
  for (const event of events) {
    if (event.event === "lifecycle") states.push(event.state);
  }
  return states;
}

describe("embody 三源收敛", () => {
  it("正常插入：S1→S2→S3，turn 得到回复并落盘", async () => {
    const started = await bootSuite();
    const { embody, events } = bootEmbody(started.url);

    const session = await embody.start();
    expect(embody.state()).toBe("S3_INSTANTIATED");
    expect(lifecycleStates(events)).toEqual(["S1_AUTH", "S2_CONVERGE", "S3_INSTANTIATED"]);

    const after = await embody.turn("你好");
    expect(after.sessionId).toBe(session.sessionId);
    expect(after.turns).toBe(1);
    expect(after.messages.at(-1)?.text).toBe("[stub-a] 你好");

    const persisted = await latestSession(core.coreId);
    expect(persisted?.messages.length).toBe(2);
    expect(persisted?.turns).toBe(1);
  });

  it("PIN 错误进入 SX_REJECTED 且错误码为 E_BIO", async () => {
    const started = await bootSuite();
    const { embody } = bootEmbody(started.url, { pin: "00000000" });

    await expect(embody.start()).rejects.toMatchObject({ code: "E_BIO" });
    expect(embody.state()).toBe("SX_REJECTED");
  });

  it("未插卡时拒绝启动（E_NOT_MOUNTED）", async () => {
    const started = await bootSuite();
    ejectCore();
    const { embody } = bootEmbody(started.url);

    await expect(embody.start()).rejects.toMatchObject({ code: "E_NOT_MOUNTED" });
  });

  it("Mobile Suite 不可达时拒绝启动（E_SOURCE_MISSING）", async () => {
    const started = await bootSuite();
    await started.close();
    suite = null;
    const { embody } = bootEmbody(started.url);

    await expect(embody.start()).rejects.toMatchObject({ code: "E_SOURCE_MISSING" });
    expect(embody.state()).toBe("SX_REJECTED");
  });
});

describe("embody 解相干", () => {
  it("decohere 后状态为 S4，量子写入与设备请求抛 E_DECOMP", async () => {
    const started = await bootSuite();
    const { embody } = bootEmbody(started.url);
    await embody.start();

    await embody.decohere("mount-vanished");
    expect(embody.state()).toBe("S4_DECOHERED");
    expect(() => embody.assertCoherent()).toThrowError(/re-read/);
    await expect(embody.turn("after")).rejects.toMatchObject({ code: "E_DECOMP" });
    await expect(embody.device({ device: "led", op: "device.led.set", args: { on: true } })).rejects.toMatchObject({
      code: "E_DECOMP",
    });

    const log = await readFile(path.join(dataDir, "run", "decohere.log"), "utf8");
    expect(log).toContain("mount-vanished");
  });
});

describe("embody 与 Mobile Suite 的设备双校验", () => {
  it("合法请求得到 ok，设备状态真的改变", async () => {
    const started = await bootSuite();
    const { embody } = bootEmbody(started.url);
    await embody.start();

    const verdict = await embody.device({ device: "led", op: "device.led.set", args: { on: true } });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe("ok");

    const led = started.iface().state.find((entry) => entry.deviceId === "led");
    expect(led?.state.on).toBe(true);
  });
});

describe("embody 会话持久化", () => {
  it("重新插卡后同一 sessionId 与历史，贡献记录自检与授权双判为真", async () => {
    const started = await bootSuite();
    const first = bootEmbody(started.url);
    const session = await first.embody.start();
    await first.embody.turn("第一轮");
    await first.embody.decohere("ejected");

    const contributions = await readFile(
      path.join(dataDir, "cores", core.coreId, "contribute.jsonl"),
      "utf8",
    );
    for (const line of contributions.trim().split("\n")) {
      const record = JSON.parse(line) as { selfCheck: boolean; granted: boolean };
      expect(record.selfCheck).toBe(true);
      expect(record.granted).toBe(true);
    }

    const second = bootEmbody(started.url);
    const recovered = await second.embody.start();
    expect(recovered.sessionId).toBe(session.sessionId);
    expect(recovered.turns).toBe(1);
    expect(lifecycleStates(second.events)).toContain("S5_RECOVER");
  });

  it("换 provider 不改 sessionId，下一条回复前缀切换", async () => {
    const started = await bootSuite();
    const { embody } = bootEmbody(started.url);
    const session = await embody.start();
    await embody.turn("第一轮");
    const before = await latestSession(core.coreId);

    saveProviderConfig(dataDir, { name: "stub-b", model: "stub-2" });
    const after = await embody.turn("第二轮");
    expect(after.sessionId).toBe(session.sessionId);
    expect(after.messages.at(-1)?.text).toBe("[stub-b] 第二轮");
    expect(after.messages.length).toBe((before?.messages.length ?? 0) + 2);
  });
});
