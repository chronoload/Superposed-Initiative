import { utf8ToBytes } from "@noble/hashes/utils.js";

import { b64urlDecode, b64urlEncode, canonical } from "./canonical.ts";
import type { Envelope, EnvelopeDraft } from "./envelope.ts";
import { signBytes, verifyBytes } from "./keys.ts";

export const MAX_CLOCK_SKEW_MS = 60_000;
export const MAX_ENVELOPE_AGE_MS = 300_000;

export type EnvelopeVerdict =
  | { ok: true }
  | { ok: false; code: "E_SIG" | "E_STALE" | "E_VERSION" };

function signingBytes(env: EnvelopeDraft): Uint8Array {
  return utf8ToBytes(
    canonical({
      id: env.id,
      source: env.source,
      type: env.type,
      ts: env.ts,
      version: env.version,
      corrId: env.corrId,
      payload: env.payload,
    }),
  );
}

export function signEnvelope(env: EnvelopeDraft, priv: Uint8Array): Envelope {
  return {
    id: env.id,
    source: env.source,
    type: env.type,
    ts: env.ts,
    version: env.version,
    corrId: env.corrId,
    payload: env.payload,
    sig: b64urlEncode(signBytes(signingBytes(env), priv)),
  };
}

export function verifyEnvelope(env: Envelope, pub: Uint8Array): EnvelopeVerdict {
  let signature: Uint8Array;
  try {
    signature = b64urlDecode(env.sig);
  } catch {
    return { ok: false, code: "E_SIG" };
  }

  if (!verifyBytes(signature, signingBytes(env), pub)) return { ok: false, code: "E_SIG" };
  if (env.version !== "0.1") return { ok: false, code: "E_VERSION" };

  const now = Date.now();
  if (env.ts > now + MAX_CLOCK_SKEW_MS || env.ts < now - MAX_ENVELOPE_AGE_MS) {
    return { ok: false, code: "E_STALE" };
  }

  return { ok: true };
}
