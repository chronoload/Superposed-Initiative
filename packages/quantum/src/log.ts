import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import {
  REQUIRED_FIELDS,
  b64urlDecode,
  b64urlEncode,
  canonical,
  isLegal,
  sha256hex,
  zEnvelope,
  zPlaintextHeader,
} from "@superpose/protocol";
import type {
  Category,
  Envelope,
  PlaintextHeader,
  ProtocolSubset,
} from "@superpose/protocol";

import {
  QUANTUM_NONCE_BYTES,
  QUANTUM_TAG_BYTES,
  QuantumError,
  concatBytes,
  zQuantumRecord,
} from "./entry.ts";
import type { QuantumEntry, QuantumRecord } from "./entry.ts";
import { interpretableSubset } from "./subset.ts";
import type { InterpretableEntry } from "./subset.ts";

export const QUANTUM_LOG_FILE = "quantum.jsonl";

/** 全局状态量子在 Valid Space 中的一个点：当前全部条目的折叠结果。 */
export type QuantumPoint = {
  seq: number;
  digest: string;
  records: QuantumRecord[];
};

export interface QuantumLog {
  append(env: Envelope, header: PlaintextHeader, keyIds: string[]): Promise<QuantumRecord>;
  materialize(): Promise<QuantumPoint>;
  subset(
    point: QuantumPoint,
    q: { keyIds: string[]; grants: string[]; categories?: Category[] },
  ): InterpretableEntry[];
  lastSeq(): number;
}

const KEY_ID_PATTERN = /^key_[a-z0-9]{8,32}$/;
const GENESIS_DIGEST = "";

/** `aad = base64url(canonical({ id, source, type, ts, version, corrId }))`（3.2 节写死）。 */
export function envelopeAad(
  env: Pick<Envelope, "id" | "source" | "type" | "ts" | "version" | "corrId">,
): Uint8Array {
  return new TextEncoder().encode(
    canonical({
      id: env.id,
      source: env.source,
      type: env.type,
      ts: env.ts,
      version: env.version,
      corrId: env.corrId,
    }),
  );
}

/** `digest = sha256(prevDigest || canonical(记录除 digest))`（3.2 节写死）。 */
export function chainDigest(prevDigest: string, body: Omit<QuantumRecord, "digest">): string {
  return sha256hex(`${prevDigest}${canonical(body)}`);
}

function decodeFixedField(text: string, length: number, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(text);
  } catch {
    throw new QuantumError("E_DECOMP", `${label} is not valid base64url`);
  }
  if (bytes.length !== length) {
    throw new QuantumError("E_DECOMP", `${label} must be exactly ${length} bytes`);
  }
  return bytes;
}

class FileQuantumLog implements QuantumLog {
  #file: string;
  #seq = -1;
  #digest = GENESIS_DIGEST;
  #queue: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, QUANTUM_LOG_FILE);
    this.#hydrate();
  }

  #hydrate(): void {
    if (!existsSync(this.#file)) return;
    const lines = readFileSync(this.#file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const last = lines.at(-1);
    if (last === undefined) return;

    let raw: unknown;
    try {
      raw = JSON.parse(last);
    } catch {
      throw new QuantumError("E_CHAIN_TAMPERED", "quantum log tail is not valid JSON");
    }
    if (typeof raw !== "object" || raw === null) {
      throw new QuantumError("E_CHAIN_TAMPERED", "quantum log tail is not a record");
    }
    const tail = raw as { seq?: unknown; digest?: unknown };
    if (
      typeof tail.seq !== "number" ||
      !Number.isInteger(tail.seq) ||
      tail.seq < 0 ||
      typeof tail.digest !== "string"
    ) {
      throw new QuantumError("E_CHAIN_TAMPERED", "quantum log tail is missing seq/digest");
    }
    this.#seq = tail.seq;
    this.#digest = tail.digest;
  }

  lastSeq(): number {
    return this.#seq;
  }

  append(env: Envelope, header: PlaintextHeader, keyIds: string[]): Promise<QuantumRecord> {
    const run = this.#queue.then(() => this.#append(env, header, keyIds));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #append(env: Envelope, header: PlaintextHeader, keyIds: string[]): Promise<QuantumRecord> {
    let envelope: Envelope;
    try {
      envelope = zEnvelope.parse(env);
    } catch {
      throw new QuantumError("E_LEGALITY", "envelope shape is invalid");
    }

    let plaintextHeader: PlaintextHeader;
    try {
      plaintextHeader = zPlaintextHeader.parse(header);
    } catch {
      throw new QuantumError("E_LEGALITY", "plaintextHeader shape is invalid");
    }

    if (!Array.isArray(keyIds) || keyIds.length < 1) {
      throw new QuantumError("E_KEYIDS_EMPTY", "append requires at least one recipient keyId");
    }
    for (const id of keyIds) {
      if (typeof id !== "string" || !KEY_ID_PATTERN.test(id)) {
        throw new QuantumError("E_LEGALITY", `invalid recipient keyId: ${String(id)}`);
      }
    }

    const subset: ProtocolSubset = {
      legalFields: [...REQUIRED_FIELDS[plaintextHeader.category], ...plaintextHeader.fields],
    };
    const verdict = isLegal(plaintextHeader, subset);
    if (!verdict.ok) {
      throw new QuantumError(verdict.code, `illegal quantum header: ${verdict.code}`);
    }

    const { payload } = envelope;
    if (payload.enc !== "aead") {
      throw new QuantumError(
        "E_LEGALITY",
        "append requires an aead payload; seal plaintext via sealEntry before contributing",
      );
    }

    const expectedAad = b64urlEncode(envelopeAad(envelope));
    if (payload.body.aad !== expectedAad) {
      throw new QuantumError("E_DECOMP", "aad does not bind to the envelope header");
    }

    const nonce = decodeFixedField(payload.body.nonce, QUANTUM_NONCE_BYTES, "nonce");
    let sealed: Uint8Array;
    try {
      sealed = b64urlDecode(payload.body.ciphertext);
    } catch {
      throw new QuantumError("E_DECOMP", "ciphertext is not valid base64url");
    }
    if (sealed.length < QUANTUM_TAG_BYTES + 1) {
      throw new QuantumError("E_DECOMP", "ciphertext is too short");
    }

    const entry: QuantumEntry = {
      keyId: payload.body.keyId,
      alg: payload.body.alg,
      aad: payload.body.aad,
      ciphertext: b64urlEncode(concatBytes(nonce, sealed)),
      plaintextHeader,
    };

    const body: Omit<QuantumRecord, "digest"> = {
      seq: this.#seq + 1,
      envelopeId: envelope.id,
      sourceKind: envelope.source.kind,
      sourceId: envelope.source.id,
      type: envelope.type,
      ts: envelope.ts,
      version: envelope.version,
      corrId: envelope.corrId,
      entry,
    };
    const record: QuantumRecord = { ...body, digest: chainDigest(this.#digest, body) };

    try {
      zQuantumRecord.parse(record);
    } catch {
      throw new QuantumError("E_LEGALITY", "assembled quantum record is invalid");
    }

    await appendFile(this.#file, `${JSON.stringify(record)}\n`, "utf8");
    this.#seq = record.seq;
    this.#digest = record.digest;
    return record;
  }

  async materialize(): Promise<QuantumPoint> {
    let text = "";
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") throw error;
    }

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const records: QuantumRecord[] = [];
    let prevDigest = GENESIS_DIGEST;

    for (const [index, line] of lines.entries()) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} is not valid JSON`);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} is not an object`);
      }

      const { digest: rawDigest, ...body } = raw as { digest?: unknown } & Record<string, unknown>;
      if (typeof rawDigest !== "string") {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} has no digest`);
      }
      const expected = sha256hex(`${prevDigest}${canonical(body)}`);
      if (rawDigest !== expected) {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} digest mismatch`);
      }

      let record: QuantumRecord;
      try {
        record = zQuantumRecord.parse(raw);
      } catch {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} violates the record schema`);
      }
      if (record.seq !== index) {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} has non-contiguous seq`);
      }
      if (record.digest !== rawDigest) {
        throw new QuantumError("E_CHAIN_TAMPERED", `record ${index} digest is not canonical`);
      }

      prevDigest = record.digest;
      records.push(record);
    }

    return {
      seq: records.length - 1,
      digest: prevDigest,
      records,
    };
  }

  subset(
    point: QuantumPoint,
    q: { keyIds: string[]; grants: string[]; categories?: Category[] },
  ): InterpretableEntry[] {
    return interpretableSubset(point, {
      keyIds: q.keyIds,
      grants: q.grants,
      adaptation: q.categories === undefined ? undefined : { categories: q.categories },
    });
  }
}

/**
 * 打开（必要时创建）某个目录下的 `quantum.jsonl`。
 * 契约 0.6 的载体路径是 `data/quantum/quantum.jsonl`，因此调用方传 `data/quantum`。
 */
export function openLog(dir: string): QuantumLog {
  return new FileQuantumLog(dir);
}
