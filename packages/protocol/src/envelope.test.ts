import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  b64urlDecode,
  b64urlEncode,
  canonical,
  encodePrivateKey,
  encodePublicKey,
  decodePrivateKey,
  decodePublicKey,
  generateKeyPair,
  keyIdOf,
  keyRingOf,
  publicKeyFromRing,
  publicKeyOf,
  sha256hex,
  signEnvelope,
  verifyEnvelope,
} from "./index.ts";
import type { Envelope, EnvelopeDraft, PlaintextHeader } from "./index.ts";
import { LEGAL_CATEGORIES, REQUIRED_FIELDS, SCHEMA_FOR_CATEGORY, isLegal } from "./legal.ts";
import { mintEnvelope, parseEnvelope } from "./envelope.ts";
import type { ProtocolSubset } from "./legal.ts";
import { MAX_CLOCK_SKEW_MS, MAX_ENVELOPE_AGE_MS } from "./sign.ts";

const pair = generateKeyPair();
const KEY_ID = keyIdOf(pair.publicKey);
const CORE_ID = "core_0123456789abcdef";

function draft(overrides: Partial<EnvelopeDraft> = {}): EnvelopeDraft {
  return {
    ...mintEnvelope({
      kind: "agent-core",
      sourceId: CORE_ID,
      type: "core.contribute",
      payload: { enc: "plain", body: { region: "terminal-local" } },
    }),
    ...overrides,
  };
}

function header(category: (typeof LEGAL_CATEGORIES)[number], overrides: Record<string, unknown> = {}): PlaintextHeader {
  return {
    category,
    sensitivity: "P1",
    keyIds: [KEY_ID],
    schema: { name: SCHEMA_FOR_CATEGORY[category], version: "1" },
    fields: [...REQUIRED_FIELDS[category]],
    ...overrides,
  } as PlaintextHeader;
}

const subset: ProtocolSubset = {
  legalFields: LEGAL_CATEGORIES.flatMap((category) => [...REQUIRED_FIELDS[category]]),
};

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code units and emits no whitespace", () => {
    expect(canonical({ b: 2, a: 1, Z: [3, { d: 4, c: 5 }] })).toBe('{"Z":[3,{"c":5,"d":4}],"a":1,"b":2}');
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it("is stable across repeated calls and repeated sha256", () => {
    const value = { z: "末尾", a: [1, true, null], nested: { y: 2, x: undefined } };
    expect(canonical(value)).toBe(canonical(value));
    expect(sha256hex(canonical(value))).toBe(sha256hex(canonical(value)));
    expect(sha256hex(canonical(value))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops undefined object fields while preserving array positions", () => {
    expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonical([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("keeps strings verbatim (no unicode normalization)", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(canonical(composed)).toBe(JSON.stringify(composed));
    expect(canonical(decomposed)).toBe(JSON.stringify(decomposed));
    expect(canonical(composed)).not.toBe(canonical(decomposed));
  });

  it("rejects values that are not JSON", () => {
    expect(() => canonical(undefined)).toThrow();
    expect(() => canonical(1n)).toThrow();
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (let length = 0; length <= 8; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
      const encoded = b64urlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toContain("=");
      expect([...b64urlDecode(encoded)]).toEqual([...bytes]);
    }
  });

  it("matches known vectors", () => {
    expect(b64urlEncode(new Uint8Array())).toBe("");
    expect(b64urlEncode(Uint8Array.from([0]))).toBe("AA");
    expect(b64urlEncode(Uint8Array.from([0, 0]))).toBe("AAA");
    expect(b64urlEncode(Uint8Array.from([255, 255, 255]))).toBe("____");
  });

  it("rejects malformed text", () => {
    expect(() => b64urlDecode("A")).toThrow();
    expect(() => b64urlDecode("ab+c")).toThrow();
    expect(() => b64urlDecode("ab/c")).toThrow();
  });
});

describe("keys", () => {
  it("derives 32-byte keys and stable key ids", () => {
    const local = generateKeyPair();
    expect(local.publicKey).toHaveLength(32);
    expect(local.privateKey).toHaveLength(32);
    expect([...publicKeyOf(local.privateKey)]).toEqual([...local.publicKey]);
    expect(keyIdOf(local.publicKey)).toMatch(/^key_[a-z0-9]{8,32}$/);
    expect(keyIdOf(local.publicKey)).toBe(keyIdOf(local.publicKey));
    expect(keyIdOf(local.publicKey)).not.toBe(keyIdOf(pair.publicKey));
  });

  it("round-trips public and private key encodings", () => {
    expect(decodePublicKey(encodePublicKey(pair.publicKey))).toEqual(pair.publicKey);
    expect(decodePrivateKey(encodePrivateKey(pair.privateKey))).toEqual(pair.privateKey);
    expect(encodePublicKey(pair.publicKey)).toHaveLength(43);
  });

  it("builds a key ring keyed by keyId", () => {
    const ring = keyRingOf([pair.publicKey]);
    expect(publicKeyFromRing(ring, KEY_ID)).toEqual(pair.publicKey);
    expect(publicKeyFromRing(ring, "key_0000000000000000")).toBeUndefined();
  });
});

describe("envelope minting and parsing", () => {
  it("defaults corrId to the envelope id and pins version 0.1", () => {
    const minted = draft();
    expect(minted.corrId).toBe(minted.id);
    expect(minted.version).toBe("0.1");
    expect(minted.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps an explicit corrId", () => {
    const corrId = randomUUID();
    expect(draft({ corrId }).corrId).toBe(corrId);
  });

  it("parses its own signed output, including JSON strings", () => {
    const signed = signEnvelope(draft(), pair.privateKey);
    expect(parseEnvelope(signed)).toEqual(signed);
    expect(parseEnvelope(JSON.stringify(signed))).toEqual(signed);
  });

  it("rejects source ids whose prefix does not match kind", () => {
    const mismatched = { ...draft(), source: { kind: "mobile-suite" as const, id: CORE_ID } };
    expect(() => parseEnvelope(mismatched)).toThrow();
  });

  it("rejects structurally incomplete envelopes", () => {
    const { type: _type, ...incomplete } = draft();
    expect(() => parseEnvelope(incomplete)).toThrow();
    expect(() => parseEnvelope({ ...draft(), sig: "short" })).toThrow();
  });
});

describe("envelope signatures", () => {
  it("signs and verifies a plain payload", () => {
    const signed = signEnvelope(draft(), pair.privateKey);
    expect(verifyEnvelope(signed, pair.publicKey)).toEqual({ ok: true });
  });

  it("signs the aead payload without needing the plaintext", () => {
    const payload = {
      enc: "aead" as const,
      body: {
        keyId: KEY_ID,
        alg: "xchacha20poly1305" as const,
        nonce: b64urlEncode(Uint8Array.from({ length: 24 }, (_, index) => index)),
        aad: b64urlEncode(Uint8Array.from({ length: 12 }, (_, index) => index + 1)),
        ciphertext: b64urlEncode(Uint8Array.from({ length: 17 }, (_, index) => index + 2)),
      },
    };
    const signed = signEnvelope(draft({ payload }), pair.privateKey);
    expect(verifyEnvelope(signed, pair.publicKey)).toEqual({ ok: true });

    const tampered: Envelope = {
      ...signed,
      payload: {
        enc: "aead",
        body: { ...payload.body, ciphertext: `${payload.body.ciphertext.slice(0, -1)}A` },
      },
    };
    expect(verifyEnvelope(tampered, pair.publicKey)).toEqual({ ok: false, code: "E_SIG" });
  });

  it("rejects every tampered header field with E_SIG", () => {
    const signed = signEnvelope(draft(), pair.privateKey);
    const tamperings: Array<[string, (env: Envelope) => Envelope]> = [
      ["id", (env) => ({ ...env, id: randomUUID() })],
      ["source.kind", (env) => ({ ...env, source: { ...env.source, kind: "mobile-suite" } })],
      ["source.id", (env) => ({ ...env, source: { ...env.source, id: "core_fedcba9876543210" } })],
      ["type", (env) => ({ ...env, type: "session.head" })],
      ["ts", (env) => ({ ...env, ts: env.ts + 1 })],
      ["version", (env) => ({ ...env, version: "0.2" as unknown as "0.1" })],
      ["corrId", (env) => ({ ...env, corrId: randomUUID() })],
      ["payload", (env) => ({ ...env, payload: { enc: "plain", body: { region: "remote" } } })],
      ["sig", (env) => ({ ...env, sig: `${env.sig.slice(0, -2)}AA` })],
    ];
    for (const [, mutate] of tamperings) {
      expect(verifyEnvelope(mutate(signed), pair.publicKey)).toEqual({ ok: false, code: "E_SIG" });
    }
  });

  it("rejects signatures from a different key", () => {
    const signed = signEnvelope(draft(), pair.privateKey);
    const other = generateKeyPair();
    expect(verifyEnvelope(signed, other.publicKey)).toEqual({ ok: false, code: "E_SIG" });
  });

  it("rejects malformed signature text without throwing", () => {
    const signed = { ...signEnvelope(draft(), pair.privateKey), sig: "!".repeat(86) };
    expect(verifyEnvelope(signed, pair.publicKey)).toEqual({ ok: false, code: "E_SIG" });
  });

  it("rejects stale envelopes in both directions with E_STALE", () => {
    const now = Date.now();
    const old = signEnvelope(draft({ ts: now - MAX_ENVELOPE_AGE_MS - 1_000 }), pair.privateKey);
    const future = signEnvelope(draft({ ts: now + MAX_CLOCK_SKEW_MS + 1_000 }), pair.privateKey);
    expect(verifyEnvelope(old, pair.publicKey)).toEqual({ ok: false, code: "E_STALE" });
    expect(verifyEnvelope(future, pair.publicKey)).toEqual({ ok: false, code: "E_STALE" });
  });

  it("rejects an unsupported version with E_VERSION once the signature is valid", () => {
    const signed = signEnvelope(draft({ version: "0.2" as unknown as "0.1" }), pair.privateKey);
    expect(verifyEnvelope(signed, pair.publicKey)).toEqual({ ok: false, code: "E_VERSION" });
  });
});

describe("legal information judgment", () => {
  it("accepts a minimal header for every legal category", () => {
    for (const category of LEGAL_CATEGORIES) {
      expect(isLegal(header(category), subset)).toEqual({ ok: true });
    }
  });

  it("rejects a missing required field with E_FIELDS_MISSING", () => {
    expect(isLegal(header("env", { fields: ["region", "epochMs"] }), subset)).toEqual({
      ok: false,
      code: "E_FIELDS_MISSING",
    });
    expect(isLegal(header("perm", { fields: ["subjectId", "op", "resource"] }), subset)).toEqual({
      ok: false,
      code: "E_FIELDS_MISSING",
    });
  });

  it("rejects a schema/category mismatch with E_CATEGORY_MISMATCH", () => {
    expect(isLegal(header("env", { schema: { name: "perm.v1", version: "1" } }), subset)).toEqual({
      ok: false,
      code: "E_CATEGORY_MISMATCH",
    });
  });

  it("rejects unknown categories and unknown schema versions", () => {
    expect(isLegal(header("env", { category: "secret" }), subset)).toEqual({ ok: false, code: "E_LEGALITY" });
    expect(isLegal(header("env", { schema: { name: "env.v1", version: "2" } }), subset)).toEqual({
      ok: false,
      code: "E_VERSION",
    });
  });

  it("rejects fields outside the declared protocol subset", () => {
    expect(
      isLegal(header("env", { fields: [...REQUIRED_FIELDS.env, "privateNote"] }), subset),
    ).toEqual({ ok: false, code: "E_LEGALITY" });
  });

  it("rejects an empty key id list with E_KEYIDS_EMPTY", () => {
    expect(isLegal(header("device", { keyIds: [] }), subset)).toEqual({ ok: false, code: "E_KEYIDS_EMPTY" });
  });

  it("ignores body content entirely because it only sees the plaintext header", () => {
    const withSensitiveLookingFields = header("device", {
      fields: [...REQUIRED_FIELDS.device],
      sensitivity: "P3",
    });
    expect(isLegal(withSensitiveLookingFields, subset)).toEqual({ ok: true });
  });
});
