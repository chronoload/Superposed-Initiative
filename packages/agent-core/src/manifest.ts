import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  b64url32,
  b64urlEncode,
  coreId as coreIdSchema,
  encodePrivateKey,
  encodePublicKey,
  generateKeyPair,
  keyId as keyIdSchema,
  keyIdOf,
  sha256hex,
} from "@superpose/protocol";
import type { ProtocolErrorCode } from "@superpose/protocol";
import { z } from "zod";

export class AgentCoreError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "AgentCoreError";
    this.code = code;
  }
}

export function isAgentCoreError(value: unknown, code?: ProtocolErrorCode): value is AgentCoreError {
  if (!(value instanceof AgentCoreError)) return false;
  if (code === undefined) return true;
  return value.code === code;
}

/** Agent Core 全部运行数据的根目录；测试通过 SUPERPOSE_DATA 注入隔离目录。 */
export function dataRoot(): string {
  const override = process.env.SUPERPOSE_DATA;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.resolve(process.cwd(), "data");
}

export function coreDirOf(coreId: string): string {
  return path.join(dataRoot(), "cores", coreId);
}

/** 裁决 6：legalFields 是负载字段名白名单，默认写入全部 15 个名字。 */
const PAYLOAD_FIELDS = [
  "region",
  "epochMs",
  "subjects",
  "subjectId",
  "op",
  "resource",
  "granteeKeyIds",
  "notBefore",
  "notAfter",
  "deviceId",
  "ops",
  "meta",
  "ownerSuiteId",
  "state",
  "observedAt",
] as const;

const CONTRIBUTES = ["identity.public", "session.head", "iface.usage"] as const;

export const zCoreManifest = z
  .object({
    coreId: coreIdSchema,
    displayName: z.string().min(1).max(48),
    createdAt: z.number().int().positive(),
    schemaVersion: z.literal(1),
    protocolSubset: z.object({
      baseline: z.literal("0.1"),
      trimmed: z.array(z.string().min(1).max(32)).max(16),
      legalFields: z.array(z.enum(PAYLOAD_FIELDS)).min(6).max(16),
    }),
    identity: z
      .object({
        did: z.string().regex(/^did:superpose:[a-z0-9]{8,40}$/),
        kind: z.literal("agent"),
        owner: z.string().min(1).max(64),
        provenance: z.object({
          issuer: z.string().min(1).max(64),
          issuedAt: z.number().int().positive(),
          derivedFrom: z.string().nullable(),
        }),
      })
      .strict(),
    keys: z
      .object({
        coreSigningPub: b64url32,
        coreBoxPub: b64url32,
      })
      .strict(),
    keyIds: z.array(keyIdSchema).min(1).max(8),
    contributes: z.array(z.enum(CONTRIBUTES)).max(8),
  })
  .strict();

export type CoreManifest = z.infer<typeof zCoreManifest>;

function manifestPath(coreId: string): string {
  return path.join(coreDirOf(coreId), "manifest.json");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function parseManifest(text: string, coreId: string): CoreManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AgentCoreError("E_MANIFEST_SHAPE", `manifest for ${coreId} is not valid JSON`);
  }
  const parsed = zCoreManifest.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new AgentCoreError("E_MANIFEST_SHAPE", `invalid manifest for ${coreId}: ${detail}`);
  }
  return parsed.data;
}

export async function loadManifest(coreId: string): Promise<CoreManifest> {
  let text: string;
  try {
    text = await readFile(manifestPath(coreId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentCoreError("E_SOURCE_MISSING", `manifest for ${coreId} does not exist`);
    }
    throw error;
  }
  return parseManifest(text, coreId);
}

export async function saveManifest(coreId: string, manifest: CoreManifest): Promise<void> {
  const parsed = zCoreManifest.safeParse(manifest);
  if (!parsed.success) {
    throw new AgentCoreError("E_MANIFEST_SHAPE", `refusing to save an invalid manifest for ${coreId}`);
  }
  await writeJsonAtomic(manifestPath(coreId), parsed.data);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export type ProvisionInput = {
  displayName: string;
  owner?: string;
  issuer?: string;
  quantumKeyIds: string[];
  pin: string;
  coreId?: string;
  seed?: Uint8Array;
};

export type ProvisionedCore = {
  manifest: CoreManifest;
  coreSecretKey: string;
  coreKeyId: string;
  pin: string;
  coreId: string;
};

export async function provisionCore(input: ProvisionInput): Promise<ProvisionedCore> {
  const pair = generateKeyPair(input.seed);
  const publicKeyText = encodePublicKey(pair.publicKey);
  const pubDigest = sha256hex(pair.publicKey);
  const coreId = input.coreId ?? `core_${pubDigest.slice(0, 16)}`;
  const coreDir = coreDirOf(coreId);

  await mkdir(path.join(coreDir, "keys"), { recursive: true });
  await mkdir(path.join(coreDir, "privatized"), { recursive: true });
  await mkdir(path.join(coreDir, "sessions"), { recursive: true });

  const now = Date.now();
  // [stub] MVP 不引入 X25519：以签名公钥的 sha256 摘要充当 coreBoxPub 占位。
  const coreBoxPub = b64urlEncode(hexToBytes(pubDigest));

  const manifest: CoreManifest = {
    coreId,
    displayName: input.displayName,
    createdAt: now,
    schemaVersion: 1,
    protocolSubset: {
      baseline: "0.1",
      trimmed: [],
      legalFields: [...PAYLOAD_FIELDS],
    },
    identity: {
      did: `did:superpose:${pubDigest.slice(0, 20)}`,
      kind: "agent",
      owner: input.owner ?? "demo-owner",
      provenance: {
        issuer: input.issuer ?? "demo-issuer",
        issuedAt: now,
        derivedFrom: null,
      },
    },
    keys: {
      coreSigningPub: publicKeyText,
      coreBoxPub,
    },
    keyIds: [...input.quantumKeyIds],
    contributes: [...CONTRIBUTES],
  };

  await saveManifest(coreId, manifest);
  await writeJsonAtomic(path.join(coreDir, "keys", "pub.json"), {
    coreSigningPub: publicKeyText,
    coreBoxPub,
  });
  await writeFile(path.join(coreDir, "privatized", "pin.digest"), sha256hex(input.pin), "utf8");
  await writeJsonAtomic(path.join(coreDir, "sessions", "index.json"), { latest: null, all: [] });

  return {
    manifest,
    coreSecretKey: encodePrivateKey(pair.privateKey),
    coreKeyId: keyIdOf(pair.publicKey),
    pin: input.pin,
    coreId,
  };
}
