import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map<string, number>(Array.from(ALPHABET, (char, index) => [char, index]));

function encodeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";

  const kind = typeof value;
  if (kind === "boolean") return value ? "true" : "false";
  if (kind === "number") return JSON.stringify(value) ?? "null";
  if (kind === "string") return JSON.stringify(value);
  if (kind === "bigint") throw new TypeError("canonical JSON cannot encode bigint");
  if (kind === "function" || kind === "symbol") return undefined;

  if (Array.isArray(value)) {
    const items = value.map((item) => encodeValue(item) ?? "null");
    return `[${items.join(",")}]`;
  }

  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = encodeValue(record[key]);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }

  return undefined;
}

export function canonical(value: unknown): string {
  const encoded = encodeValue(value);
  if (encoded === undefined) throw new TypeError("canonical JSON requires a JSON value");
  return encoded;
}

export function sha256hex(bytes: Uint8Array | string): string {
  const input = typeof bytes === "string" ? utf8ToBytes(bytes) : bytes;
  return bytesToHex(sha256(input));
}

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    out += ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    out += ALPHABET[third & 0b111111];
  }
  return out;
}

export function b64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("invalid base64url text");
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Error("invalid base64url text");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
