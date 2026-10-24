import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDemoServer } from "../src/server.ts";
import type { DemoServer } from "../src/server.ts";

type Json = Record<string, unknown>;

let demo: DemoServer;
let dataDir = "";

async function call(pathname: string, body?: Json): Promise<Json> {
  const response = await fetch(`${demo.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Json;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-demo-"));
  demo = await createDemoServer({ port: 0, suitePort: 0, dataDir });
}, 90_000);

afterAll(async () => {
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("demo 主流程", () => {
  it("插入→对话→设备→弹出→重插，状态序列与历史保持", async () => {
    const inserted = await call("/api/core/insert", {});
    const coreId = String(inserted.coreId);
    expect(coreId.startsWith("core_")).toBe(true);

    const state1 = await call("/api/state");
    const session1 = state1.session as Json;
    const sessionId = String(session1.sessionId);
    expect(state1.state).toBe("S3_INSTANTIATED");
    expect((state1.lifecycle as string[]).slice(0, 3)).toEqual([
      "S1_AUTH",
      "S2_CONVERGE",
      "S3_INSTANTIATED",
    ]);
    expect((session1.messages as unknown[]).length).toBe(0);

    const turn1 = await call("/api/turn", { text: "你好" });
    expect(String(turn1.text)).toBe("[stub-a] 你好");
    expect(turn1.turns).toBe(1);

    const verdict = await call("/api/device", {
      device: "led",
      op: "device.led.set",
      args: { on: true },
    });
    expect(verdict.ok).toBe(true);

    await call("/api/provider", { name: "stub-b", model: "stub-2" });
    const ejected = await call("/api/core/eject", {});
    expect(ejected.state).toBe("S4_DECOHERED");
    expect(Number(ejected.elapsedMs)).toBeLessThan(2000);

    expect(await exists(path.join(dataDir, "terminal", "mount", "core.json"))).toBe(false);

    let pidGone = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await exists(path.join(dataDir, "run", "embody.pid")))) {
        pidGone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(pidGone).toBe(true);

    const decohere = (await readFile(path.join(dataDir, "run", "decohere.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(decohere.length).toBe(1);
    expect(JSON.parse(decohere[0] as string)).toMatchObject({
      reason: "mount-vanished",
      lateWrites: 0,
    });

    const reinserted = await call("/api/core/insert", {});
    expect(String(reinserted.coreId)).toBe(coreId);
    const state2 = await call("/api/state");
    expect((state2.lifecycle as string[]).slice(0, 7)).toEqual([
      "S1_AUTH",
      "S2_CONVERGE",
      "S3_INSTANTIATED",
      "S3_INSTANTIATED",
      "S4_DECOHERED",
      "S5_RECOVER",
      "S3_INSTANTIATED",
    ]);
    const session2 = state2.session as Json;
    expect(String(session2.sessionId)).toBe(sessionId);
    expect(session2.turns).toBe(1);

    const turn2 = await call("/api/turn", { text: "第二轮" });
    expect(String(turn2.text)).toBe("[stub-b] 第二轮");
    expect(turn2.turns).toBe(2);

    const state3 = await call("/api/state");
    const session3 = state3.session as Json;
    expect(String(session3.sessionId)).toBe(sessionId);
    expect((session3.messages as unknown[]).length).toBe(5);
    expect(Number(state3.quantum)).toBeGreaterThan(0);
  }, 90_000);
});
