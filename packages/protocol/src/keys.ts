import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { b64urlDecode, b64urlEncode, sha256hex } from "./canonical.ts";

ed.hashes.sha512 = sha512;

const PUBLIC_KEY_BYTES = 32;
const PRIVATE_KEY_BYTES = 32;
const KEY_ID_HEX_LENGTH = 16;

export type KeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

function assertLength(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`${label} must be exactly ${length} bytes`);
  }
  return bytes;
}

export function generateKeyPair(seed?: Uint8Array): KeyPair {
  const privateKey =
    seed === undefined ? ed.utils.randomSecretKey() : assertLength(seed, PRIVATE_KEY_BYTES, "seed");
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(assertLength(privateKey, PRIVATE_KEY_BYTES, "private key"));
}

export function signBytes(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed.sign(message, assertLength(privateKey, PRIVATE_KEY_BYTES, "private key"));
}

export function verifyBytes(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed.verify(signature, message, assertLength(publicKey, PUBLIC_KEY_BYTES, "public key"));
  } catch {
    return false;
  }
}

export function encodePublicKey(publicKey: Uint8Array): string {
  return b64urlEncode(assertLength(publicKey, PUBLIC_KEY_BYTES, "public key"));
}

export function decodePublicKey(text: string): Uint8Array {
  return assertLength(b64urlDecode(text), PUBLIC_KEY_BYTES, "public key");
}

export function encodePrivateKey(privateKey: Uint8Array): string {
  return b64urlEncode(assertLength(privateKey, PRIVATE_KEY_BYTES, "private key"));
}

export function decodePrivateKey(text: string): Uint8Array {
  return assertLength(b64urlDecode(text), PRIVATE_KEY_BYTES, "private key");
}

export function keyIdOf(publicKey: Uint8Array): string {
  return `key_${sha256hex(assertLength(publicKey, PUBLIC_KEY_BYTES, "public key")).slice(0, KEY_ID_HEX_LENGTH)}`;
}

export type KeyRing = ReadonlyMap<string, Uint8Array>;

export function keyRingOf(publicKeys: readonly Uint8Array[]): KeyRing {
  return new Map(publicKeys.map((publicKey) => [keyIdOf(publicKey), assertLength(publicKey, PUBLIC_KEY_BYTES, "public key")]));
}

export function publicKeyFromRing(ring: KeyRing, keyId: string): Uint8Array | undefined {
  return ring.get(keyId);
}
