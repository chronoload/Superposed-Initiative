import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AgentCoreError,
  appendAudit,
  appendTurn,
  assertMounted,
  comparePin,
  contribute,
  dataRoot,
  latestSession,
} from "@superpose/agent-core";
import type { SessionMessage, SessionRecord } from "@superpose/agent-core";
import {
  b64urlDecode,
  b64urlEncode,
  canonical,
  decodePublicKey,
  keyIdOf,
  mintEnvelope,
  signBytes,
  signEnvelope,
} from "@superpose/protocol";
import type { Envelope, PlaintextHeader } from "@superpose/protocol";
import { envelopeAad, keyIdOfSecret, openEntry, openLog, sealEntry } from "@superpose/quantum";
import type { QuantumPoint } from "@superpose/quantum";
import { zDeviceVerdict } from "@superpose/mobile-suite";
import type { DeviceId, DeviceOp, DeviceVerdict } from "@superpose/mobile-suite";

import { converge } from "./converge.ts";
import type { Convergence } from "./converge.ts";
import { createProvider, loadProviderConfig } from "./provider.ts";
import { watchMount } from "./watch.ts";

export const LIFECYCLE_STATES = [
  "S0_EJECTED",
  "S1_AUTH",
  "S2_CONVERGE",
  "S3_INSTANTIATED",
  "S4_DECOHERED",
  "S5_RECOVER",
  "SX_REJECTED",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export type EmbodyEvent =
  | { event: "lifecycle"; state: LifecycleState }
  | { event: "turn"; sessionId: string; turns: number; provider: string; text: string }
  | { event: "turn-failed"; code: string }
  | { event: "request"; requestId: string; op: string; ok: boolean; reason: string }
  | { event: "rejected"; code: string; detail?: string }
  | { event: "degraded"; missing: string[] };

export type EmbodyOptions = {
  coreId: string;
  pin: string;
  coreSecretKey: Uint8Array;
  quantumKey: Uint8Array;
  suiteUrl?: string;
  onDecohere?: () => void;
};

export type Embody = {
  state(): LifecycleState;
  session(): SessionRecord | null;
  onEvent(listener: (event: EmbodyEvent) => void): void;
  start(): Promise<SessionRecord>;
  turn(text: string): Promise<SessionRecord>;
  device: (input: {
    device: DeviceId;
    op: DeviceOp;
    args?: Record<string, unknown>;
  }) => Promise<DeviceVerdict>;
  assertCoherent(): void;
  decohere(reason: string): Promise<void>;
  stop(): void;
};

const DEFAULT_SUITE_URL = "http://127.0.0.1:7318";
const DEVICE_REQUEST_LIFETIME_MS = 30_000;

function reasonOf(code: string): string {
  if (code === "E_SIG") return "sig-invalid";
  if (code === "E_SOURCE_MISSING") return "source-missing";
  if (code === "E_VERSION") return "incompatible";
  if (code === "E_BIO" || code === "E_LOCKED") return "auth-failed";
  return code;
}

async function appendDecohere(coreId: string, reason: string): Promise<void> {
  const file = path.join(dataRoot(), "run", "decohere.log");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    `${JSON.stringify({ at: Date.now(), coreId, reason, lateWrites: 0 })}\n`,
    "utf8",
  );
}

/** 把正文封成 aead Envelope 并签名（与 Mobile Suite 的封包方式一致）。 */
async function sealedEnvelope(input: {
  kind: "agent-core";
  sourceId: string;
  type: "session.head";
  secretKey: Uint8Array;
  quantumKey: Uint8Array;
  body: Record<string, unknown>;
}): Promise<Envelope> {
  const draft = mintEnvelope({
    kind: input.kind,
    sourceId: input.sourceId,
    type: input.type,
    payload: { enc: "plain", body: {} },
  });
  const aad = envelopeAad(draft);
  const sealed = await sealEntry(new TextEncoder().encode(canonical(input.body)), input.quantumKey, aad);
  const blob = b64urlDecode(sealed.ciphertext);
  return signEnvelope(
    {
      ...draft,
      payload: {
        enc: "aead",
        body: {
          keyId: sealed.keyId,
          alg: "xchacha20poly1305",
          nonce: b64urlEncode(blob.slice(0, 24)),
          aad: sealed.aad,
          ciphertext: b64urlEncode(blob.slice(24)),
        },
      },
    },
    input.secretKey,
  );
}

async function latestGrantId(
  point: QuantumPoint,
  coreId: string,
  quantumKey: Uint8Array,
): Promise<string | null> {
  const now = Date.now();
  let found: string | null = null;
  for (const record of point.records) {
    if (record.type !== "perm.grant") continue;
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await openEntry(record.entry, quantumKey)));
      if (typeof parsed !== "object" || parsed === null) continue;
      body = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (body.subjectId !== coreId) continue;
    if (typeof body.notAfter === "number" && now > body.notAfter) continue;
    found = record.envelopeId;
  }
  return found;
}

export function createEmbody(options: EmbodyOptions): Embody {
  const coreId = options.coreId;
  const suiteUrl = options.suiteUrl ?? DEFAULT_SUITE_URL;
  const quantumKeyId = keyIdOfSecret(options.quantumKey);

  let state: LifecycleState = "S0_EJECTED";
  let coherent = true;
  let session: SessionRecord | null = null;
  let embodiment: Convergence | null = null;
  let unwatch: (() => void) | null = null;
  let abort: AbortController | null = null;
  let stopped = false;
  const listeners: Array<(event: EmbodyEvent) => void> = [];

  function emit(event: EmbodyEvent): void {
    for (const listener of listeners) listener(event);
  }

  function setState(next: LifecycleState): void {
    state = next;
    emit({ event: "lifecycle", state: next });
  }

  function assertCoherent(): void {
    if (!coherent || stopped) {
      throw new AgentCoreError("E_DECOMP", "embodiment is decohered; material must be re-read");
    }
  }

  async function reject(error: unknown): Promise<never> {
    const code = error instanceof AgentCoreError ? error.code : "E_SOURCE_MISSING";
    await appendDecohere(coreId, reasonOf(code)).catch(() => undefined);
    setState("SX_REJECTED");
    emit({ event: "rejected", code, detail: error instanceof Error ? error.message : undefined });
    throw error;
  }

  async function start(): Promise<SessionRecord> {
    stopped = false;
    coherent = true;
    const previous = await latestSession(coreId).catch(() => null);
    const recovering = previous !== null;
    // 重插走 S5_RECOVER，不再重复广播 S1/S2，生命周期序列保持 S4→S5→S3
    if (recovering) setState("S5_RECOVER");
    else setState("S1_AUTH");
    try {
      assertMounted(coreId);
      const pinVerdict = await comparePin(coreId, options.pin);
      if (!pinVerdict.ok) {
        await appendAudit(coreId, { action: "auth.fail", code: pinVerdict.code }).catch(() => undefined);
        throw new AgentCoreError(pinVerdict.code, "biometric comparison rejected");
      }
      await appendAudit(coreId, { action: "auth.ok" }).catch(() => undefined);
      if (!recovering) setState("S2_CONVERGE");

      const provider = loadProviderConfig(dataRoot());
      const converged = await converge({
        coreId,
        dataDir: dataRoot(),
        provider,
        suiteUrl,
        quantumKey: options.quantumKey,
      });
      embodiment = converged;
      session = converged.session;
      if (converged.degraded) emit({ event: "degraded", missing: converged.missingDevices });

      setState("S3_INSTANTIATED");
      unwatch = watchMount(
        () => {
          void decohere("mount-vanished");
        },
        { expectedCoreId: coreId },
      );
      return session;
    } catch (error) {
      return reject(error);
    }
  }

  async function contributeSessionHead(record: SessionRecord): Promise<void> {
    if (embodiment === null) return;
    const header: PlaintextHeader = {
      category: "env",
      sensitivity: "P1",
      keyIds: [quantumKeyId],
      schema: { name: "env.v1", version: "1" },
      fields: ["region", "epochMs", "subjects"],
    };
    const envelope = await sealedEnvelope({
      kind: "agent-core",
      sourceId: coreId,
      type: "session.head",
      secretKey: options.coreSecretKey,
      quantumKey: options.quantumKey,
      body: {
        region: "local",
        epochMs: Date.now(),
        subjects: [coreId],
        sessionId: record.sessionId,
        turns: record.turns,
      },
    });
    await contribute(coreId, openLog(path.join(dataRoot(), "quantum")), {
      envelope,
      header,
      keyIds: header.keyIds,
      field: "session.head",
      granted: embodiment.permGrantId !== null,
    });
  }

  async function turn(text: string): Promise<SessionRecord> {
    assertCoherent();
    if (session === null) throw new AgentCoreError("E_DECOMP", "no runtime session");
    assertMounted(coreId);
    const current = session;

    const snapshot = loadProviderConfig(dataRoot());
    const provider = createProvider(snapshot);
    abort = new AbortController();
    const now = Date.now();
    const userMessage: SessionMessage = {
      seq: current.messages.length,
      role: "user",
      text,
      ts: now,
      provider: { ...snapshot },
    };

    try {
      const reply = await provider.chat(
        [...current.messages, userMessage].map((message) => ({ role: message.role, text: message.text })),
        abort.signal,
      );
      const assistant: SessionMessage = {
        seq: current.messages.length + 1,
        role: "assistant",
        text: reply,
        ts: Date.now(),
        provider: { ...snapshot },
      };
      const saved = await appendTurn(coreId, {
        ...current,
        provider: { ...snapshot },
        messages: [...current.messages, userMessage, assistant],
        turns: current.turns + 1,
        updatedAt: Date.now(),
      });
      session = saved;
      emit({
        event: "turn",
        sessionId: saved.sessionId,
        turns: saved.turns,
        provider: snapshot.name,
        text: reply,
      });
      await contributeSessionHead(saved).catch(() => undefined);
      return saved;
    } catch (error) {
      await appendAudit(coreId, { action: "turn.fail" }).catch(() => undefined);
      emit({ event: "turn-failed", code: error instanceof Error ? error.message : "E_PROVIDER" });
      throw error;
    } finally {
      abort = null;
    }
  }

  async function device(input: {
    device: DeviceId;
    op: DeviceOp;
    args?: Record<string, unknown>;
  }): Promise<DeviceVerdict> {
    assertCoherent();
    if (session === null || embodiment === null) {
      throw new AgentCoreError("E_DECOMP", "no runtime session");
    }
    assertMounted(coreId);

    const point = await openLog(path.join(dataRoot(), "quantum")).materialize();
    const permissionRef = await latestGrantId(point, coreId, options.quantumKey);
    if (permissionRef === null) {
      throw new AgentCoreError("E_PERM_UNKNOWN", "no valid perm.grant for this Agent Core");
    }

    const now = Date.now();
    const body = {
      id: randomUUID(),
      corrId: randomUUID(),
      requester: {
        coreId,
        sessionId: session.sessionId,
        keyId: keyIdOf(decodePublicKey(embodiment.manifest.keys.coreSigningPub)),
      },
      target: { deviceId: input.device },
      op: input.op,
      args: input.args ?? {},
      issuedAt: now,
      expiresAt: now + DEVICE_REQUEST_LIFETIME_MS,
      permissionRef,
    };
    const sig = b64urlEncode(signBytes(new TextEncoder().encode(canonical(body)), options.coreSecretKey));

    const response = await fetch(`${suiteUrl}/device-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, sig }),
    });
    if (!response.ok) {
      throw new AgentCoreError("E_SOURCE_MISSING", `mobile suite returned ${response.status}`);
    }
    const verdict = zDeviceVerdict.parse(await response.json());

    const toolMessage: SessionMessage = {
      seq: session.messages.length,
      role: "tool",
      text: JSON.stringify(verdict),
      ts: Date.now(),
      provider: { ...session.provider },
    };
    session = await appendTurn(coreId, {
      ...session,
      messages: [...session.messages, toolMessage],
      updatedAt: Date.now(),
    });

    emit({
      event: "request",
      requestId: verdict.requestId,
      op: input.op,
      ok: verdict.ok,
      reason: verdict.reason,
    });
    return verdict;
  }

  async function decohere(reason: string): Promise<void> {
    if (!coherent) return;
    coherent = false;
    abort?.abort();
    abort = null;
    unwatch?.();
    unwatch = null;
    session = null;
    await appendDecohere(coreId, reason).catch(() => undefined);
    setState("S4_DECOHERED");
    options.onDecohere?.();
  }

  function stop(): void {
    stopped = true;
    coherent = false;
    abort?.abort();
    abort = null;
    unwatch?.();
    unwatch = null;
    state = "S0_EJECTED";
  }

  return {
    state: () => state,
    session: () => session,
    onEvent: (listener) => {
      listeners.push(listener);
    },
    start,
    turn,
    device,
    assertCoherent,
    decohere,
    stop,
  };
}
