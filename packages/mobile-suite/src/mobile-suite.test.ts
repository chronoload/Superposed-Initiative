import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  b64urlDecode,
  b64urlEncode,
  canonical,
  generateKeyPair,
  keyIdOf,
  signBytes,
} from "@superpose/protocol";
import type { KeyPair } from "@superpose/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { startSuite } from "./index.ts";
import type { DeviceId, DeviceOp, DeviceRequest, DeviceVerdict, MobileSuite } from "./index.ts";
import { DEVICE_OPS } from "./device.ts";

const SUITE_ID = "suite_0123456789abcdef";
const CORE_ID = "core_0123456789abcdef";
const UNKNOWN_CORE_ID = "core_ffffffffffffffff";
const SESSION_ID = globalThis.crypto.randomUUID();

const CORE_KEYS = generateKeyPair(new Uint8Array(32).fill(1));
const OTHER_KEYS = generateKeyPair(new Uint8Array(32).fill(2));
const SUITE_KEYS = generateKeyPair(new Uint8Array(32).fill(3));
const QUANTUM_KEY = new Uint8Array(32).fill(7);

const ALLOW_ALL = { allow: { [CORE_ID]: [...DEVICE_OPS] } as Record<string, string[]> };

let suite: MobileSuite | undefined;
let dataDir = "";

async function boot(policy?: { allow: Record<string, string[]> }): Promise<MobileSuite> {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-suite-"));
  const started = await startSuite({
    dataDir,
    suiteId: SUITE_ID,
    secretKey: SUITE_KEYS.privateKey,
    quantumKey: QUANTUM_KEY,
    port: 0,
    ...(policy === undefined ? {} : { policy }),
  });
  started.registerCoreKey(CORE_ID, b64urlEncode(CORE_KEYS.publicKey));
  // 等所有 iface 条目落入全局状态量子后再验请求。
  await started.publishIface();
  suite = started;
  return started;
}

afterEach(async () => {
  if (suite !== undefined) {
    await suite.close();
    suite = undefined;
  }
  if (dataDir !== "") {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = "";
  }
});

type RequestInput = {
  keys: KeyPair;
  coreId: string;
  deviceId: DeviceId;
  op: DeviceOp;
  args: Record<string, unknown>;
  permissionRef: string;
  issuedAt?: number;
  expiresAt?: number;
};

function makeRequest(input: RequestInput): DeviceRequest {
  const now = Date.now();
  const issuedAt = input.issuedAt ?? now;
  const expiresAt = input.expiresAt ?? now + 10_000;
  const body = {
    id: globalThis.crypto.randomUUID(),
    corrId: globalThis.crypto.randomUUID(),
    requester: {
      coreId: input.coreId,
      sessionId: SESSION_ID,
      keyId: keyIdOf(input.keys.publicKey),
    },
    target: { deviceId: input.deviceId },
    op: input.op,
    args: input.args,
    issuedAt,
    expiresAt,
    permissionRef: input.permissionRef,
  };
  const sig = b64urlEncode(
    signBytes(new TextEncoder().encode(canonical(body)), input.keys.privateKey),
  );
  return { ...body, sig };
}

async function post(s: MobileSuite, body: unknown): Promise<DeviceVerdict> {
  const response = await fetch(`${s.url}/device-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceVerdict;
}

type IfaceResponse = {
  iface: {
    suiteId: string;
    ownerSuiteId: string;
    schema: { name: string; version: string };
    devices: Array<{ deviceId: string; ops: string[]; meta: Record<string, unknown> }>;
    coreKeys: Record<string, string>;
    suitePublicKey: string;
  };
  state: Array<{ deviceId: string; state: Record<string, unknown>; observedAt: number }>;
};

async function getIface(s: MobileSuite): Promise<IfaceResponse> {
  const response = await fetch(`${s.url}/iface`);
  expect(response.status).toBe(200);
  return (await response.json()) as IfaceResponse;
}

async function readLog(): Promise<string[]> {
  const file = path.join(dataDir, "terminal", "mobilesuite", "requests.jsonl");
  const text = await readFile(file, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0);
}

describe("mobile suite device request double check", () => {
  it("never trusts a self-declared permission in args", async () => {
    const s = await boot(ALLOW_ALL);

    const noGrant = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true, permission: "all" },
        permissionRef: globalThis.crypto.randomUUID(),
      }),
    );
    expect(noGrant).toMatchObject({ ok: false, reason: "E_PERM_UNKNOWN" });

    const displayOnly = await s.publishGrant(CORE_ID, { ops: ["device.display.write"] });
    const overreaching = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true, permission: "all" },
        permissionRef: displayOnly,
      }),
    );
    expect(overreaching).toMatchObject({ ok: false, reason: "E_OP_NOT_GRANTED" });

    const lines = await readLog();
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("permission");
    expect(lines.join("\n")).not.toContain('"all"');
  });

  it("rejects an expired request with E_STALE", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);

    const now = Date.now();
    const verdict = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true },
        permissionRef: grantId,
        issuedAt: now - 5_000,
        expiresAt: now - 1_000,
      }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "E_STALE" });
  });

  it("rejects an expired grant with E_PERM_EXPIRED", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID, { ttlMs: -1 });

    const verdict = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true },
        permissionRef: grantId,
      }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "E_PERM_EXPIRED" });
  });

  it("rejects an op that policy.json does not allow with E_POLICY", async () => {
    const s = await boot({ allow: { [CORE_ID]: ["device.display.write"] } });
    const grantId = await s.publishGrant(CORE_ID);

    const verdict = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true },
        permissionRef: grantId,
      }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "E_POLICY" });
  });

  it("rejects a tampered signature with E_SIG", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);
    const request = makeRequest({
      keys: CORE_KEYS,
      coreId: CORE_ID,
      deviceId: "led",
      op: "device.led.set",
      args: { on: true },
      permissionRef: grantId,
    });

    const bytes = b64urlDecode(request.sig);
    bytes[0] = (bytes[0] as number) ^ 0xff;
    const verdict = await post(s, { ...request, sig: b64urlEncode(bytes) });
    expect(verdict).toMatchObject({ ok: false, reason: "E_SIG" });
  });

  it("rejects a core whose public key is absent from the quantum with E_SIG", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);

    const verdict = await post(
      s,
      makeRequest({
        keys: OTHER_KEYS,
        coreId: UNKNOWN_CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true },
        permissionRef: grantId,
      }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "E_SIG" });
  });

  it("rejects a structurally invalid request with E_SIG", async () => {
    const s = await boot(ALLOW_ALL);
    const verdict = await post(s, { id: globalThis.crypto.randomUUID(), op: "device.led.set" });
    expect(verdict).toMatchObject({ ok: false, reason: "E_SIG" });
  });

  it("logs exactly one context-free line per request", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);

    const first = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true, note: "do-not-log-this" },
        permissionRef: grantId,
      }),
    );
    const second = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: false, permission: "all" },
        permissionRef: globalThis.crypto.randomUUID(),
      }),
    );

    expect(first).toMatchObject({ ok: true, reason: "ok" });
    expect(second).toMatchObject({ ok: false, reason: "E_PERM_UNKNOWN" });
    expect(s.requests()).toBe(2);

    const lines = await readLog();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([
        "checkedAt",
        "op",
        "reason",
        "requestId",
        "verdict",
      ]);
    }
    const text = lines.join("\n");
    expect(text).not.toContain("do-not-log-this");
    expect(text).not.toContain("permission");
    expect(text).not.toContain(JSON.stringify({ on: true }));
  });

  it("executes a fully authorized request and mutates device state", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);

    const before = await getIface(s);
    const beforeLed = before.state.find((entry) => entry.deviceId === "led");
    expect(beforeLed?.state).toEqual({ on: false });
    expect(before.iface.ownerSuiteId).toBe(SUITE_ID);
    expect(before.iface.schema).toEqual({ name: "iface.v1", version: "1" });
    expect(before.iface.devices.map((device) => device.deviceId)).toEqual([
      "led",
      "display",
      "sensor",
    ]);
    expect(before.iface.devices.map((device) => device.deviceId).sort()).toEqual(
      before.state.map((entry) => entry.deviceId).sort(),
    );
    expect(before.iface.coreKeys[CORE_ID]).toBe(b64urlEncode(CORE_KEYS.publicKey));

    const verdict = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "led",
        op: "device.led.set",
        args: { on: true },
        permissionRef: grantId,
      }),
    );
    expect(verdict).toMatchObject({ ok: true, reason: "ok" });

    const after = await getIface(s);
    const afterLed = after.state.find((entry) => entry.deviceId === "led");
    expect(afterLed?.state).toEqual({ on: true });
    expect(afterLed?.observedAt ?? 0).toBeGreaterThanOrEqual(beforeLed?.observedAt ?? 0);

    const display = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "display",
        op: "device.display.write",
        args: { text: "hello" },
        permissionRef: grantId,
      }),
    );
    expect(display).toMatchObject({ ok: true, reason: "ok" });
    const sensor = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "sensor",
        op: "device.sensor.read",
        args: {},
        permissionRef: grantId,
      }),
    );
    expect(sensor).toMatchObject({ ok: true, reason: "ok" });

    const finalState = await getIface(s);
    expect(finalState.state.find((entry) => entry.deviceId === "display")?.state).toEqual({
      text: "hello",
    });
    expect(await readLog()).toHaveLength(3);
  });

  it("treats device execution failures as E_POLICY and still logs", async () => {
    const s = await boot(ALLOW_ALL);
    const grantId = await s.publishGrant(CORE_ID);

    const verdict = await post(
      s,
      makeRequest({
        keys: CORE_KEYS,
        coreId: CORE_ID,
        deviceId: "display",
        op: "device.display.write",
        args: { text: "x".repeat(201) },
        permissionRef: grantId,
      }),
    );
    expect(verdict).toMatchObject({ ok: false, reason: "E_POLICY" });
    expect(await readLog()).toHaveLength(1);
  });
});
