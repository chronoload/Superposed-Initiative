import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ejectCore,
  isAgentCoreError,
  latestSession,
  loadManifest,
  mountCore,
  provisionCore,
} from "@superpose/agent-core";
import type { CoreManifest, SessionRecord } from "@superpose/agent-core";
import { b64urlEncode, encodePrivateKey, generateKeyPair, sha256hex } from "@superpose/protocol";
import { keyIdOfSecret, openLog } from "@superpose/quantum";
import type { QuantumRecord } from "@superpose/quantum";
import { DEVICE_OPS, startSuite } from "@superpose/mobile-suite";
import type { DeviceId, DeviceOp, DeviceVerdict, MobileSuite } from "@superpose/mobile-suite";
import { loadProviderConfig, saveProviderConfig } from "@superpose/embody";
import type { EmbodyEvent, LifecycleState } from "@superpose/embody";

export type DemoPhase = "ejected" | "instantiating" | "instantiated" | "decohered" | "rejected";

export type DemoTranscriptEntry = { role: "user" | "assistant" | "tool"; text: string };

export type DemoQuantumView = {
  seq: number;
  type: string;
  sourceKind: string;
  sourceId: string;
  sensitivity: string;
  keyIds: string[];
  fields: string[];
  digest: string;
  ts: number;
};

export type DemoSources = {
  agentCore: {
    coreId: string;
    baseline: string;
    legalFields: number;
    contributes: string[];
    signingKey: string;
    boxKey: string;
  };
  quantum: { total: number; reachable: number; byType: Record<string, number> };
  mobileSuite: { suiteId: string; devices: string[]; registeredKeys: number };
};

export type DemoDecohere = { at: number; reason: string; lateWrites: number };

export type DemoSnapshot = {
  state: LifecycleState;
  lifecycle: LifecycleState[];
  phase: DemoPhase;
  coreId: string | null;
  session: SessionRecord | null;
  provider: { name: string; model: string };
  transcript: DemoTranscriptEntry[];
  lastVerdict: DeviceVerdict | null;
  iface: { suiteId: string; devices: string[] };
  quantum: number;
  quantumLog: DemoQuantumView[];
  sources: DemoSources;
  decohere: DemoDecohere | null;
  paths: { quantum: string; mount: string; decohere: string; sessions: string };
  mounted: boolean;
  active: boolean;
  pid: number | null;
  stderr: string;
};

export type OrchestratorOptions = {
  dataDir: string;
  suitePort?: number;
  embodyEntry: string;
  repoRoot: string;
  pin?: string;
};

export type DemoOrchestrator = {
  initialize(): Promise<void>;
  insert(): Promise<{ coreId: string; state: LifecycleState; lifecycle: LifecycleState[] }>;
  eject(options?: { noreap?: boolean }): Promise<{ state: LifecycleState; elapsedMs: number }>;
  turn(text: string): Promise<{ text: string; turns: number; sessionId: string }>;
  device(input: {
    device: DeviceId;
    op: DeviceOp;
    args?: Record<string, unknown>;
  }): Promise<DeviceVerdict>;
  provider(name: string, model?: string): Promise<{ name: string; model: string }>;
  snapshot(): Promise<DemoSnapshot>;
  onEvent(listener: (event: EmbodyEvent) => void): void;
  dataDir(): string;
  close(): Promise<void>;
};

export class DemoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DemoError";
    this.code = code;
  }
}

const PROVIDER_NAMES = ["stub-a", "stub-b"] as const;
const INSERT_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 20_000;

function seedBytes(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`superpose-demo:${label}`).digest());
}

type Waiter = {
  match: (event: EmbodyEvent) => boolean;
  resolve: (event: EmbodyEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function createOrchestrator(options: OrchestratorOptions): DemoOrchestrator {
  const dataDir = options.dataDir;
  const pin = options.pin ?? process.env.SUPERPOSE_DEMO_PIN ?? "24681357";
  const quantumKey = seedBytes("quantum");
  const coreSeed = seedBytes("core");
  const suiteSeed = seedBytes("suite");
  const corePair = generateKeyPair(coreSeed);
  const suitePair = generateKeyPair(suiteSeed);
  const coreId = `core_${sha256hex(corePair.publicKey).slice(0, 16)}`;
  const suiteId = `suite_${sha256hex(suitePair.publicKey).slice(0, 16)}`;

  let suite: MobileSuite | null = null;
  let manifest: CoreManifest | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let pid: number | null = null;
  let phase: DemoPhase = "ejected";
  let current: LifecycleState = "S0_EJECTED";
  let lifecycle: LifecycleState[] = [];
  let transcript: DemoTranscriptEntry[] = [];
  let lastVerdict: DeviceVerdict | null = null;
  let stderr = "";
  let buffer = "";

  const waiters: Waiter[] = [];
  const listeners: Array<(event: EmbodyEvent) => void> = [];

  function notify(event: EmbodyEvent): void {
    for (const listener of listeners) listener(event);
    for (const waiter of [...waiters]) {
      if (!waiter.match(event)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  }

  function waitFor(
    match: (event: EmbodyEvent) => boolean,
    timeoutMs: number,
  ): Promise<EmbodyEvent> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new DemoError("E_TIMEOUT", "timed out waiting for an Embody event"));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  async function ensureCore(): Promise<CoreManifest> {
    try {
      manifest = await loadManifest(coreId);
      return manifest;
    } catch (error) {
      if (!isAgentCoreError(error, "E_SOURCE_MISSING")) throw error;
      const provisioned = await provisionCore({
        coreId,
        seed: coreSeed,
        displayName: "Superpose Demo Agent Core",
        owner: "demo-owner",
        issuer: "demo-issuer",
        pin,
        quantumKeyIds: [keyIdOfSecret(quantumKey)],
      });
      manifest = provisioned.manifest;
      return manifest;
    }
  }

  async function initialize(): Promise<void> {
    process.env.SUPERPOSE_DATA = dataDir;
    await mkdir(path.join(dataDir, "run"), { recursive: true });
    await ensureCore();

    suite = await startSuite({
      dataDir,
      suiteId,
      secretKey: suitePair.privateKey,
      quantumKey,
      port: options.suitePort ?? 7318,
      policy: { allow: { [coreId]: [...DEVICE_OPS] } },
    });
    suite.registerCoreKey(coreId, (manifest as CoreManifest).keys.coreSigningPub);
    await suite.publishIface();
    await suite.publishGrant(coreId);
  }

  function handleStdout(chunk: Buffer): void {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let event: EmbodyEvent;
      try {
        event = JSON.parse(line) as EmbodyEvent;
      } catch {
        continue;
      }
      if (event.event === "lifecycle") {
        current = event.state;
        lifecycle.push(event.state);
        if (event.state === "S3_INSTANTIATED") phase = "instantiated";
        if (event.state === "S4_DECOHERED") phase = "decohered";
        if (event.state === "SX_REJECTED") phase = "rejected";
      }
      if (event.event === "turn") {
        lifecycle.push("S3_INSTANTIATED");
        transcript.push({ role: "assistant", text: event.text });
      }
      if (event.event === "request") {
        lastVerdict = {
          requestId: event.requestId,
          ok: event.ok,
          reason: event.reason as DeviceVerdict["reason"],
          checkedAt: Date.now(),
        };
        transcript.push({ role: "tool", text: `${event.op} ${event.reason}` });
      }
      notify(event);
    }
  }

  function spawnEmbody(): ChildProcessWithoutNullStreams {
    stderr = "";
    const embody = spawn(process.execPath, [options.embodyEntry, "--core", coreId], {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        SUPERPOSE_DATA: dataDir,
        SUPERPOSE_CORE_SK: encodePrivateKey(corePair.privateKey),
        SUPERPOSE_QUANTUM_KEY: b64urlEncode(quantumKey),
        SUPERPOSE_PIN: pin,
        SUPERPOSE_SUITE_URL: suite?.url ?? "http://127.0.0.1:7318",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = embody;
    pid = embody.pid ?? null;
    buffer = "";
    embody.stdout.on("data", handleStdout);
    embody.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    embody.on("exit", () => {
      child = null;
      pid = null;
      if (phase === "instantiated" && current !== "S4_DECOHERED") phase = "rejected";
    });
    return embody;
  }

  async function insert(): Promise<{
    coreId: string;
    state: LifecycleState;
    lifecycle: LifecycleState[];
  }> {
    if (child !== null) {
      throw new DemoError("E_ALREADY_MOUNTED", "an Embody is already instantiated");
    }
    await ensureCore();
    mountCore(coreId);
    phase = "instantiating";
    const spawned = spawnEmbody();

    const settled = await Promise.race([
      waitFor((event) => event.event === "lifecycle" && event.state === "S3_INSTANTIATED", INSERT_TIMEOUT_MS),
      waitFor((event) => event.event === "rejected", INSERT_TIMEOUT_MS),
    ]);
    if (settled.event === "rejected") {
      phase = "rejected";
      spawned.kill();
      throw new DemoError(settled.code, "embody rejected convergence");
    }
    return { coreId, state: current, lifecycle: [...lifecycle] };
  }

  async function reap(timeoutMs: number): Promise<void> {
    const currentChild = child;
    if (currentChild === null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        currentChild.kill();
        resolve();
      }, timeoutMs);
      currentChild.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function eject(options2: { noreap?: boolean } = {}): Promise<{
    state: LifecycleState;
    elapsedMs: number;
  }> {
    if (child === null) return { state: "S4_DECOHERED", elapsedMs: 0 };
    const started = Date.now();
    ejectCore();
    let reached: LifecycleState = "S4_DECOHERED";
    try {
      await waitFor(
        (event) => event.event === "lifecycle" && event.state === "S4_DECOHERED",
        5_000,
      );
    } catch {
      reached = current;
    }
    const elapsedMs = Date.now() - started;
    if (options2.noreap !== true) await reap(2_500);
    return { state: reached, elapsedMs };
  }

  async function turn(text: string): Promise<{ text: string; turns: number; sessionId: string }> {
    if (child === null) throw new DemoError("E_NOT_MOUNTED", "no instantiated Embody");
    transcript.push({ role: "user", text });
    child.stdin.write(`${JSON.stringify({ cmd: "turn", text })}\n`);
    const event = await waitFor((candidate) => candidate.event === "turn", TURN_TIMEOUT_MS);
    if (event.event !== "turn") throw new DemoError("E_TIMEOUT", "unexpected event");
    return { text: event.text, turns: event.turns, sessionId: event.sessionId };
  }

  async function device(input: {
    device: DeviceId;
    op: DeviceOp;
    args?: Record<string, unknown>;
  }): Promise<DeviceVerdict> {
    if (child === null) throw new DemoError("E_NOT_MOUNTED", "no instantiated Embody");
    child.stdin.write(
      `${JSON.stringify({ cmd: "device", device: input.device, op: input.op, args: input.args ?? {} })}\n`,
    );
    const event = await waitFor((candidate) => candidate.event === "request", TURN_TIMEOUT_MS);
    if (event.event !== "request") throw new DemoError("E_TIMEOUT", "unexpected event");
    return {
      requestId: event.requestId,
      ok: event.ok,
      reason: event.reason as DeviceVerdict["reason"],
      checkedAt: Date.now(),
    };
  }

  async function provider(name: string, model?: string): Promise<{ name: string; model: string }> {
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new DemoError("E_VERSION", `unknown provider ${name}`);
    }
    const snapshot = { name, model: model ?? (name === "stub-a" ? "stub-1" : "stub-2") };
    saveProviderConfig(dataDir, snapshot);
    return snapshot;
  }

  async function snapshot(): Promise<DemoSnapshot> {
    let session: SessionRecord | null = null;
    try {
      session = await latestSession(coreId);
    } catch {
      session = null;
    }

    let records: QuantumRecord[] = [];
    try {
      records = (await openLog(path.join(dataDir, "quantum")).materialize()).records;
    } catch {
      records = [];
    }

    const core = manifest;
    const coreKeyIds = core?.keyIds ?? [];
    const reachable = records.filter((record) =>
      record.entry.plaintextHeader.keyIds.some((keyId) => coreKeyIds.includes(keyId)),
    );
    const byType: Record<string, number> = {};
    for (const record of records) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
    }
    const quantumLog: DemoQuantumView[] = records
      .slice(-10)
      .reverse()
      .map((record) => ({
        seq: record.seq,
        type: record.type,
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        sensitivity: record.entry.plaintextHeader.sensitivity,
        keyIds: record.entry.plaintextHeader.keyIds,
        fields: record.entry.plaintextHeader.fields,
        digest: record.digest.slice(0, 16),
        ts: record.ts,
      }));

    let decohere: DemoDecohere | null = null;
    try {
      const text = await readFile(path.join(dataDir, "run", "decohere.log"), "utf8");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        const parsed = JSON.parse(last) as Record<string, unknown>;
        decohere = {
          at: Number(parsed.at ?? 0),
          reason: String(parsed.reason ?? "unknown"),
          lateWrites: Number(parsed.lateWrites ?? 0),
        };
      }
    } catch {
      decohere = null;
    }

    const iface = suite?.iface();
    const devices = iface?.iface.devices.map((device) => device.deviceId) ?? [];
    return {
      state: current,
      lifecycle: [...lifecycle],
      phase,
      coreId,
      session,
      provider: loadProviderConfig(dataDir),
      transcript: [...transcript],
      lastVerdict,
      iface: iface ? { suiteId: iface.iface.suiteId, devices } : { suiteId, devices: [] },
      quantum: records.length,
      quantumLog,
      sources: {
        agentCore: {
          coreId: core?.coreId ?? coreId,
          baseline: core?.protocolSubset.baseline ?? "0.1",
          legalFields: core?.protocolSubset.legalFields.length ?? 0,
          contributes: core?.contributes ?? [],
          signingKey: core?.keys.coreSigningPub ?? "",
          boxKey: core?.keys.coreBoxPub ?? "",
        },
        quantum: { total: records.length, reachable: reachable.length, byType },
        mobileSuite: {
          suiteId: iface?.iface.suiteId ?? suiteId,
          devices,
          registeredKeys: Object.keys(iface?.iface.coreKeys ?? {}).length,
        },
      },
      decohere,
      paths: {
        quantum: "data/quantum/quantum.jsonl",
        mount: "data/terminal/mount/core.json",
        decohere: "data/run/decohere.log",
        sessions: `data/cores/${coreId}/sessions/`,
      },
      mounted: existsSync(path.join(dataDir, "terminal", "mount", "core.json")),
      active: child !== null,
      pid,
      stderr: stderr.slice(-2000),
    };
  }

  async function close(): Promise<void> {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new DemoError("E_DECOMP", "demo is closing"));
    }
    ejectCore();
    if (child !== null) {
      child.kill();
      await reap(1_500);
    }
    await suite?.close().catch(() => undefined);
    suite = null;
  }

  return {
    initialize,
    insert,
    eject,
    turn,
    device,
    provider,
    snapshot,
    onEvent: (listener) => {
      listeners.push(listener);
    },
    dataDir: () => dataDir,
    close,
  };
}
