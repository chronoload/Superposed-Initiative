import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { decodePublicKey, encodePublicKey, publicKeyOf } from "@superpose/protocol";
import { openLog } from "@superpose/quantum";
import type { QuantumPoint } from "@superpose/quantum";
import { DEVICE_OPS, devicesFor, releaseDevices } from "./device.ts";
import type { DeviceRuntime, DeviceVerdict, SuiteStateEntry } from "./device.ts";
import { buildIface, publishGrantToQuantum, publishIfaceToQuantum } from "./iface.ts";
import type { SuiteIface } from "./iface.ts";
import { loadPolicy, policyPath, savePolicy } from "./policy.ts";
import { appendRequestLog } from "./reqlog.ts";
import { verifyDeviceRequest } from "./verify.ts";

export * from "./device.ts";
export * from "./iface.ts";
export * from "./policy.ts";
export * from "./reqlog.ts";
export * from "./verify.ts";

export type SuiteConfig = {
  dataDir: string;
  suiteId: string;
  secretKey: Uint8Array;
  quantumKey: Uint8Array;
  port?: number;
  policy?: { allow: Record<string, string[]> };
};

export type MobileSuite = {
  suiteId: string;
  publicKey: string;
  port: number;
  url: string;
  iface(): { iface: SuiteIface; state: SuiteStateEntry[] };
  publishIface(): Promise<string>;
  publishGrant(
    coreId: string,
    opts?: { ops?: readonly string[]; ttlMs?: number; keyIds?: string[] },
  ): Promise<string>;
  registerCoreKey(coreId: string, publicKey: string): void;
  requests(): number;
  close(): Promise<void>;
};

const DEFAULT_PORT = 7318;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_GRANT_TTL_MS = 600_000;

type JsonValue = unknown;

function sendJson(res: ServerResponse, status: number, value: JsonValue): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflow ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function opOf(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const op = (input as { op?: unknown }).op;
    if (typeof op === "string") return op;
  }
  return "unknown";
}

function sigRejection(input: unknown): DeviceVerdict {
  let requestId: string = globalThis.crypto.randomUUID();
  if (typeof input === "object" && input !== null) {
    const id = (input as { id?: unknown }).id;
    if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      requestId = id;
    }
  }
  return { requestId, ok: false, reason: "E_SIG", checkedAt: Date.now() };
}

export async function startSuite(config: SuiteConfig): Promise<MobileSuite> {
  const dataDir = config.dataDir;
  const suiteId = config.suiteId;
  const secretKey = config.secretKey;
  const quantumKey = config.quantumKey;
  const publicKey = encodePublicKey(publicKeyOf(secretKey));

  mkdirSync(path.join(dataDir, "terminal", "mobilesuite"), { recursive: true });
  if (config.policy !== undefined) {
    savePolicy(dataDir, config.policy);
  } else if (!existsSync(policyPath(dataDir))) {
    savePolicy(dataDir, { allow: {} });
  }

  const coreKeys: Record<string, string> = {};
  const devices: DeviceRuntime = devicesFor(suiteId);
  let requestCount = 0;
  let publishTail: Promise<unknown> = Promise.resolve();

  // publishIface / publishGrant 共用一条链，避免并发写量子时 materialize 读到半行。
  function enqueuePublish<T>(task: () => Promise<T>): Promise<T> {
    const run = publishTail.then(task, task);
    publishTail = run.catch(() => undefined);
    return run;
  }

  function currentIface(): { iface: SuiteIface; state: SuiteStateEntry[] } {
    return {
      iface: buildIface({
        suiteId,
        ownerSuiteId: suiteId,
        coreKeys: { ...coreKeys },
        suitePublicKey: publicKey,
      }),
      state: devices.snapshot(),
    };
  }

  async function publishIface(): Promise<string> {
    const snapshot = { ...coreKeys };
    return enqueuePublish(() =>
      publishIfaceToQuantum({
        dataDir,
        suiteId,
        ownerSuiteId: suiteId,
        secretKey,
        quantumKey,
        coreKeys: snapshot,
      }),
    );
  }

  async function publishGrant(
    coreIdText: string,
    opts?: { ops?: readonly string[]; ttlMs?: number; keyIds?: string[] },
  ): Promise<string> {
    return enqueuePublish(() =>
      publishGrantToQuantum({
        dataDir,
        suiteId,
        secretKey,
        quantumKey,
        subjectId: coreIdText,
        ops: opts?.ops ?? DEVICE_OPS,
        ttlMs: opts?.ttlMs ?? DEFAULT_GRANT_TTL_MS,
        extraKeyIds: opts?.keyIds ?? [],
      }),
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/iface") {
      sendJson(res, 200, currentIface());
      return;
    }

    if (req.method === "POST" && url.pathname === "/device-request") {
      requestCount += 1;
      const raw = await readBody(req);

      let input: unknown = undefined;
      if (raw !== null) {
        try {
          input = JSON.parse(raw);
        } catch {
          input = undefined;
        }
      }

      let verdict: DeviceVerdict;
      if (raw === null || input === undefined) {
        verdict = sigRejection(input);
      } else {
        let point: QuantumPoint;
        try {
          point = await openLog(path.join(dataDir, "quantum")).materialize();
        } catch {
          sendJson(res, 500, { error: "E_DECOMP" });
          return;
        }
        verdict = await verifyDeviceRequest(input, {
          suiteId,
          policy: loadPolicy(dataDir),
          point,
          quantumKey,
        });
      }

      await appendRequestLog(dataDir, {
        requestId: verdict.requestId,
        op: opOf(input),
        verdict: verdict.ok,
        reason: verdict.reason,
        checkedAt: verdict.checkedAt,
      });
      sendJson(res, 200, verdict);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port ?? DEFAULT_PORT;

  return {
    suiteId,
    publicKey,
    port,
    url: `http://127.0.0.1:${port}`,
    iface: currentIface,
    publishIface,
    publishGrant,
    registerCoreKey(coreIdText: string, publicKeyText: string): void {
      decodePublicKey(publicKeyText);
      coreKeys[coreIdText] = publicKeyText;
      void publishIface().catch(() => undefined);
    },
    requests(): number {
      return requestCount;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      releaseDevices(suiteId);
    },
  };
}
