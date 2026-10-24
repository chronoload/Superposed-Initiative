import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  b64urlDecode,
  b64urlEncode,
  canonical,
  generateKeyPair,
  mintEnvelope,
  signEnvelope,
} from "@superpose/protocol";
import type { Category, Envelope, PlaintextHeader } from "@superpose/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  chainDigest,
  envelopeAad,
  interpretableSubset,
  keyIdOfSecret,
  openEntry,
  openLog,
  sealEntry,
} from "./index.ts";
import type { QuantumPoint, QuantumRecord } from "./index.ts";

const SIGNING_KEY = generateKeyPair(new Uint8Array(32).fill(3));
const ENC_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const THIRD_KEY = new Uint8Array(32).fill(11);
const ENC_KEY_ID = keyIdOfSecret(ENC_KEY);
const OTHER_KEY_ID = keyIdOfSecret(OTHER_KEY);
const THIRD_KEY_ID = keyIdOfSecret(THIRD_KEY);

const FIELDS_BY_CATEGORY: Record<Category, string[]> = {
  env: ["region", "epochMs", "subjects"],
  perm: ["subjectId", "op", "resource", "granteeKeyIds", "notBefore", "notAfter"],
  iface: ["deviceId", "ops", "meta", "ownerSuiteId"],
  device: ["deviceId", "state", "observedAt"],
};

const SCHEMA_BY_CATEGORY: Record<Category, PlaintextHeader["schema"]["name"]> = {
  env: "env.v1",
  perm: "perm.v1",
  iface: "iface.v1",
  device: "device.v1",
};

const TYPE_BY_CATEGORY = {
  env: "core.contribute",
  perm: "perm.grant",
  iface: "iface.metadata",
  device: "device.state",
} as const;

const SOURCE_BY_CATEGORY = {
  env: { kind: "agent-core", id: "core_0123456789abcdef" },
  perm: { kind: "embody", id: "embody_0123456789abcdef" },
  iface: { kind: "mobile-suite", id: "suite_0123456789abcdef" },
  device: { kind: "mobile-suite", id: "suite_0123456789abcdef" },
} as const;

function makeHeader(category: Category, keyIds: string[]): PlaintextHeader {
  return {
    category,
    sensitivity: "P1",
    keyIds,
    schema: { name: SCHEMA_BY_CATEGORY[category], version: "1" },
    fields: [...FIELDS_BY_CATEGORY[category]],
  };
}

type BuildOptions = {
  encryptKey?: Uint8Array;
  recipientKeyIds?: string[];
  plaintext?: string;
  header?: (header: PlaintextHeader) => PlaintextHeader;
};

type Built = {
  envelope: Envelope;
  plaintext: Uint8Array;
  header: PlaintextHeader;
  keyIds: string[];
};

async function buildEnvelope(category: Category, options: BuildOptions = {}): Promise<Built> {
  const encryptKey = options.encryptKey ?? ENC_KEY;
  const encryptKeyId = keyIdOfSecret(encryptKey);
  const baseHeader = makeHeader(category, options.recipientKeyIds ?? [encryptKeyId]);
  const header = options.header === undefined ? baseHeader : options.header(baseHeader);
  const plaintext = new TextEncoder().encode(options.plaintext ?? `body-${category}`);
  const source = SOURCE_BY_CATEGORY[category];

  const draft = mintEnvelope({
    kind: source.kind,
    sourceId: source.id,
    type: TYPE_BY_CATEGORY[category],
    payload: { enc: "plain", body: {} },
  });
  const sealed = await sealEntry(plaintext, encryptKey, envelopeAad(draft));
  const blob = b64urlDecode(sealed.ciphertext);
  const nonce = blob.slice(0, 24);
  const ciphertext = blob.slice(24);

  const envelope = signEnvelope(
    {
      ...draft,
      payload: {
        enc: "aead",
        body: {
          keyId: sealed.keyId,
          alg: "xchacha20poly1305",
          nonce: b64urlEncode(nonce),
          aad: sealed.aad,
          ciphertext: b64urlEncode(ciphertext),
        },
      },
    },
    SIGNING_KEY.privateKey,
  );

  return { envelope, plaintext, header, keyIds: header.keyIds };
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "superpose-quantum-"));
  tempDirs.push(dir);
  return dir;
}

async function lineCount(file: string): Promise<number> {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
}

function mutateCiphertext(record: QuantumRecord): QuantumRecord {
  const original = record.entry.ciphertext;
  const replacement = original.startsWith("A") ? "B" : "A";
  return {
    ...record,
    entry: { ...record.entry, ciphertext: `${replacement}${original.slice(1)}` },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("quantum hash chain", () => {
  it("materialize folds append-only records into one deterministic point", async () => {
    const dir = await tempDir();
    const log = openLog(dir);

    expect(log.lastSeq()).toBe(-1);
    expect((await log.materialize()).records).toHaveLength(0);

    const iface = await buildEnvelope("iface");
    const perm = await buildEnvelope("perm");
    const first = await log.append(iface.envelope, iface.header, iface.keyIds);
    const second = await log.append(perm.envelope, perm.header, perm.keyIds);

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(log.lastSeq()).toBe(1);

    const point = await log.materialize();
    expect(point.seq).toBe(1);
    expect(point.records.map((record) => record.envelopeId)).toEqual([
      iface.envelope.id,
      perm.envelope.id,
    ]);
    const { digest: secondDigest, ...secondBody } = second;
    expect(secondDigest).toBe(chainDigest(point.records[0]?.digest ?? "", secondBody));

    const again = await log.materialize();
    expect(canonical(again)).toBe(canonical(point));

    const reopened = openLog(dir);
    expect(reopened.lastSeq()).toBe(1);
    expect(canonical(await reopened.materialize())).toBe(canonical(point));
  });

  it("rejects tampering of a middle record with E_CHAIN_TAMPERED", async () => {
    const dir = await tempDir();
    const log = openLog(dir);
    for (const category of ["iface", "device", "env"] as const) {
      const built = await buildEnvelope(category);
      await log.append(built.envelope, built.header, built.keyIds);
    }
    const file = path.join(dir, "quantum.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);

    const middle = JSON.parse(lines[1] as string) as QuantumRecord;
    lines[1] = JSON.stringify(mutateCiphertext(middle));
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");

    await expect(log.materialize()).rejects.toMatchObject({ code: "E_CHAIN_TAMPERED" });
  });

  it("detects a re-hashed record because the next link no longer matches", async () => {
    const dir = await tempDir();
    const log = openLog(dir);
    for (const category of ["iface", "device", "env"] as const) {
      const built = await buildEnvelope(category);
      await log.append(built.envelope, built.header, built.keyIds);
    }
    const file = path.join(dir, "quantum.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);

    const first = JSON.parse(lines[0] as string) as QuantumRecord;
    const middle = mutateCiphertext(JSON.parse(lines[1] as string) as QuantumRecord);
    const { digest: _dropped, ...middleBody } = middle;
    const forged: QuantumRecord = { ...middleBody, digest: chainDigest(first.digest, middleBody) };
    lines[1] = JSON.stringify(forged);
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");

    await expect(log.materialize()).rejects.toMatchObject({ code: "E_CHAIN_TAMPERED" });
  });

  it("rejects illegal entries without growing the log", async () => {
    const dir = await tempDir();
    const log = openLog(dir);
    const file = path.join(dir, "quantum.jsonl");

    const iface = await buildEnvelope("iface");
    const missingField: PlaintextHeader = {
      ...iface.header,
      fields: iface.header.fields.filter((field) => field !== "meta"),
    };
    await expect(log.append(iface.envelope, missingField, iface.keyIds)).rejects.toMatchObject({
      code: "E_FIELDS_MISSING",
    });

    const perm = await buildEnvelope("perm");
    const mismatched: PlaintextHeader = {
      ...perm.header,
      schema: { name: "env.v1", version: "1" },
    };
    await expect(log.append(perm.envelope, mismatched, perm.keyIds)).rejects.toMatchObject({
      code: "E_CATEGORY_MISMATCH",
    });

    const noKeyIds: PlaintextHeader = { ...perm.header, keyIds: [] };
    await expect(log.append(perm.envelope, noKeyIds, [])).rejects.toMatchObject({
      code: "E_LEGALITY",
    });

    const plain = mintEnvelope({
      kind: "mobile-suite",
      sourceId: "suite_0123456789abcdef",
      type: "iface.metadata",
      payload: { enc: "plain", body: { deviceId: "led" } },
    });
    const plainEnvelope = signEnvelope(plain, SIGNING_KEY.privateKey);
    await expect(log.append(plainEnvelope, perm.header, perm.keyIds)).rejects.toMatchObject({
      code: "E_LEGALITY",
    });

    expect(await lineCount(file)).toBe(0);
    expect((await log.materialize()).records).toHaveLength(0);
  });

  it("rejects an entry whose aad no longer binds to the envelope header", async () => {
    const dir = await tempDir();
    const log = openLog(dir);
    const built = await buildEnvelope("iface");
    if (built.envelope.payload.enc !== "aead") throw new Error("expected aead payload");

    const forged: Envelope = {
      ...built.envelope,
      payload: {
        enc: "aead",
        body: {
          ...built.envelope.payload.body,
          aad: b64urlEncode(new TextEncoder().encode("forged-envelope-header")),
        },
      },
    };
    await expect(log.append(forged, built.header, built.keyIds)).rejects.toMatchObject({
      code: "E_DECOMP",
    });
    expect(await lineCount(path.join(dir, "quantum.jsonl"))).toBe(0);
  });

  it("keeps identical input reproducible across repeated appends", async () => {
    const dir = await tempDir();
    const log = openLog(dir);
    const built = await buildEnvelope("device");

    const first = await log.append(built.envelope, built.header, built.keyIds);
    const second = await log.append(built.envelope, built.header, built.keyIds);

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(second.entry).toEqual(first.entry);

    const one = await log.materialize();
    const two = await log.materialize();
    expect(one.records).toHaveLength(2);
    expect(canonical(one)).toBe(canonical(two));
    expect(canonical(await openLog(dir).materialize())).toBe(canonical(one));
  });
});

describe("quantum sealing", () => {
  it("round-trips with the right key and fails without it", async () => {
    const aad = new TextEncoder().encode(canonical({ id: "probe", ts: 1 }));
    const plaintext = new TextEncoder().encode("secret-body");
    const sealed = await sealEntry(plaintext, ENC_KEY, aad);

    expect(sealed.keyId).toBe(ENC_KEY_ID);
    expect(new TextDecoder().decode(await openEntry(sealed, ENC_KEY))).toBe("secret-body");
    await expect(openEntry(sealed, OTHER_KEY)).rejects.toMatchObject({ code: "E_DECOMP" });
  });

  it("produces different subsets for different keyIds", async () => {
    const dir = await tempDir();
    const log = openLog(dir);

    const iface = await buildEnvelope("iface", { encryptKey: ENC_KEY, recipientKeyIds: [ENC_KEY_ID] });
    const device = await buildEnvelope("device", {
      encryptKey: OTHER_KEY,
      recipientKeyIds: [OTHER_KEY_ID],
    });
    await log.append(iface.envelope, iface.header, iface.keyIds);
    await log.append(device.envelope, device.header, device.keyIds);

    const point = await log.materialize();
    const forOwner = interpretableSubset(point, { keyIds: [ENC_KEY_ID], grants: [] });
    const forOther = interpretableSubset(point, { keyIds: [OTHER_KEY_ID], grants: [] });
    const forNobody = interpretableSubset(point, { keyIds: [THIRD_KEY_ID], grants: [] });

    expect(forOwner.map((entry) => entry.envelopeId)).toEqual([iface.envelope.id]);
    expect(forOther.map((entry) => entry.envelopeId)).toEqual([device.envelope.id]);
    expect(forNobody).toHaveLength(0);
    expect(canonical(forOwner)).not.toBe(canonical(forOther));
  });

  it("narrows the subset by grants and still never exposes plaintext", async () => {
    const dir = await tempDir();
    const log = openLog(dir);

    const first = await buildEnvelope("iface", { plaintext: "plaintext-iface-marker" });
    const second = await buildEnvelope("device", { plaintext: "plaintext-device-marker" });
    await log.append(first.envelope, first.header, first.keyIds);
    await log.append(second.envelope, second.header, second.keyIds);

    const point: QuantumPoint = await log.materialize();
    const all = interpretableSubset(point, { keyIds: [ENC_KEY_ID], grants: [] });
    const granted = interpretableSubset(point, {
      keyIds: [ENC_KEY_ID],
      grants: [second.envelope.id],
    });
    const uncalled = interpretableSubset(point, {
      keyIds: [ENC_KEY_ID],
      grants: [first.envelope.id],
    });

    expect(all).toHaveLength(2);
    expect(granted.map((entry) => entry.envelopeId)).toEqual([second.envelope.id]);
    expect(uncalled.map((entry) => entry.envelopeId)).toEqual([first.envelope.id]);

    expect(all[0]?.plaintextHeader.category).toBe("iface");
    expect("plaintext" in (all[0] as object)).toBe(false);
    expect(JSON.stringify(all)).not.toContain("plaintext-iface-marker");
    expect(JSON.stringify(all)).not.toContain("plaintext-device-marker");

    const viaLog = log.subset(point, { keyIds: [ENC_KEY_ID], grants: [], categories: ["device"] });
    expect(viaLog.map((entry) => entry.envelopeId)).toEqual([second.envelope.id]);
  });
});
