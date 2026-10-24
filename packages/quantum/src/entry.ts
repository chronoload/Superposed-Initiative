import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import {
  ENVELOPE_TYPES,
  b64urlDecode,
  b64urlEncode,
  keyId,
  sha256hex,
  zPlaintextHeader,
} from "@superpose/protocol";
import type { PlaintextHeader, ProtocolErrorCode } from "@superpose/protocol";
import { z } from "zod";

export { LEGAL_CATEGORIES, SENSITIVITY } from "@superpose/protocol";
export { zPlaintextHeader } from "@superpose/protocol";
export type { PlaintextHeader } from "@superpose/protocol";

export const QUANTUM_ALG = "xchacha20poly1305" as const;
export const QUANTUM_NONCE_BYTES = 24;
export const QUANTUM_KEY_BYTES = 32;
export const QUANTUM_TAG_BYTES = 16;

export class QuantumError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "QuantumError";
    this.code = code;
  }
}

export function isQuantumError(value: unknown, code?: ProtocolErrorCode): value is QuantumError {
  if (!(value instanceof QuantumError)) return false;
  if (code === undefined) return true;
  return value.code === code;
}

export const zQuantumEntry = z.object({
  keyId: keyId,
  alg: z.literal(QUANTUM_ALG),
  aad: z.string().min(8).max(512),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,}$/),
  plaintextHeader: zPlaintextHeader,
});

export type QuantumEntry = z.infer<typeof zQuantumEntry>;

export const zQuantumRecord = z.object({
  seq: z.number().int().nonnegative(),
  envelopeId: z.string().uuid(),
  sourceKind: z.enum(["agent-core", "mobile-suite", "embody"]),
  sourceId: z.string().min(8).max(40),
  type: z.enum(ENVELOPE_TYPES),
  ts: z.number().int().positive(),
  version: z.literal("0.1"),
  corrId: z.string().uuid(),
  entry: zQuantumEntry,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type QuantumRecord = z.infer<typeof zQuantumRecord>;

function assertKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== QUANTUM_KEY_BYTES) {
    throw new QuantumError("E_DECOMP", `quantum key must be exactly ${QUANTUM_KEY_BYTES} bytes`);
  }
  return key;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function keyIdOfSecret(key: Uint8Array): string {
  assertKey(key);
  return `key_${sha256hex(key).slice(0, 16)}`;
}

// STUB(3.2 sealEntry): 6.2 冻结签名不含 plaintextHeader 参数，这里返回占位头部；
// log.append() 一律以调用方传入的 header 覆盖，占位值不会进入全局状态量子。
function placeholderHeader(kid: string): PlaintextHeader {
  return {
    category: "env",
    sensitivity: "P0",
    keyIds: [kid],
    schema: { name: "env.v1", version: "1" },
    fields: ["region", "epochMs", "subjects"],
  };
}

export async function sealEntry(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<QuantumEntry> {
  assertKey(key);
  if (!(plaintext instanceof Uint8Array)) throw new QuantumError("E_DECOMP", "plaintext must be bytes");
  if (plaintext.length === 0) {
    throw new QuantumError("E_DECOMP", "plaintext must be at least 1 byte to satisfy ciphertext length");
  }
  if (!(aad instanceof Uint8Array)) throw new QuantumError("E_DECOMP", "aad must be bytes");

  const kid = keyIdOfSecret(key);
  const nonce = randomBytes(QUANTUM_NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);

  return {
    keyId: kid,
    alg: QUANTUM_ALG,
    aad: b64urlEncode(aad),
    ciphertext: b64urlEncode(concatBytes(nonce, sealed)),
    plaintextHeader: placeholderHeader(kid),
  };
}

export async function openEntry(entry: QuantumEntry, key: Uint8Array): Promise<Uint8Array> {
  assertKey(key);

  let parsed: QuantumEntry;
  try {
    parsed = zQuantumEntry.parse(entry);
  } catch {
    throw new QuantumError("E_DECOMP", "quantum entry shape is invalid");
  }

  if (parsed.keyId !== keyIdOfSecret(key)) {
    throw new QuantumError("E_DECOMP", `quantum entry is not addressed to ${parsed.keyId}`);
  }

  let blob: Uint8Array;
  let aad: Uint8Array;
  try {
    blob = b64urlDecode(parsed.ciphertext);
    aad = b64urlDecode(parsed.aad);
  } catch {
    throw new QuantumError("E_DECOMP", "quantum entry encoding is invalid");
  }
  if (blob.length < QUANTUM_NONCE_BYTES + QUANTUM_TAG_BYTES + 1) {
    throw new QuantumError("E_DECOMP", "quantum entry ciphertext is too short");
  }

  const nonce = blob.slice(0, QUANTUM_NONCE_BYTES);
  const ciphertext = blob.slice(QUANTUM_NONCE_BYTES);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new QuantumError("E_DECOMP", "quantum entry decryption failed");
  }
}
