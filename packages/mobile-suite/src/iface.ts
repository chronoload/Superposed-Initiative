import path from "node:path";

import { b64urlDecode, b64urlEncode, canonical, mintEnvelope, signEnvelope } from "@superpose/protocol";
import type { Envelope, PlaintextHeader } from "@superpose/protocol";
import { envelopeAad, keyIdOfSecret, openLog, sealEntry } from "@superpose/quantum";

import { DEVICE_IDS, DEVICE_META, OPS_BY_DEVICE } from "./device.ts";
import type { DeviceId, DeviceOp } from "./device.ts";

export type SuiteIface = {
  suiteId: string;
  ownerSuiteId: string;
  schema: { name: "iface.v1"; version: "1" };
  devices: Array<{ deviceId: DeviceId; ops: readonly DeviceOp[]; meta: Record<string, unknown> }>;
  coreKeys: Record<string, string>;
  suitePublicKey: string;
};

export const IFACE_SCHEMA = { name: "iface.v1", version: "1" } as const;

export const IFACE_HEADER_FIELDS = ["deviceId", "ops", "meta", "ownerSuiteId"] as const;

/** 组装静态接口元数据（不含动态状态）。 */
export function buildIface(input: {
  suiteId: string;
  ownerSuiteId: string;
  coreKeys: Record<string, string>;
  suitePublicKey: string;
}): SuiteIface {
  return {
    suiteId: input.suiteId,
    ownerSuiteId: input.ownerSuiteId,
    schema: { name: IFACE_SCHEMA.name, version: IFACE_SCHEMA.version },
    devices: DEVICE_IDS.map((deviceId) => ({
      deviceId,
      ops: OPS_BY_DEVICE[deviceId],
      meta: DEVICE_META[deviceId],
    })),
    coreKeys: { ...input.coreKeys },
    suitePublicKey: input.suitePublicKey,
  };
}

/** 把加密正文封进 Envelope 并追加到全局状态量子。 */
async function publishEntry(input: {
  dataDir: string;
  suiteId: string;
  secretKey: Uint8Array;
  quantumKey: Uint8Array;
  type: "iface.metadata" | "perm.grant";
  header: PlaintextHeader;
  body: Record<string, unknown>;
}): Promise<string> {
  const draft = mintEnvelope({
    kind: "mobile-suite",
    sourceId: input.suiteId,
    type: input.type,
    payload: { enc: "plain", body: {} },
  });

  const aad = envelopeAad(draft);
  const plaintext = new TextEncoder().encode(canonical(input.body));
  const sealed = await sealEntry(plaintext, input.quantumKey, aad);
  const blob = b64urlDecode(sealed.ciphertext);
  const nonce = b64urlEncode(blob.slice(0, 24));
  const ciphertext = b64urlEncode(blob.slice(24));

  const envelope: Envelope = signEnvelope(
    {
      ...draft,
      payload: {
        enc: "aead",
        body: {
          keyId: sealed.keyId,
          alg: "xchacha20poly1305",
          nonce,
          aad: sealed.aad,
          ciphertext,
        },
      },
    },
    input.secretKey,
  );

  await openLog(path.join(input.dataDir, "quantum")).append(envelope, input.header, input.header.keyIds);
  return envelope.id;
}

/**
 * 发布静态接口元数据：每个设备一条 iface.metadata。
 * coreKeys 只放在加密正文里（fields 只报名字，且必须 ⊆ 主清单负载字段）。
 * 返回最后一条条目的 envelopeId。
 */
export async function publishIfaceToQuantum(input: {
  dataDir: string;
  suiteId: string;
  ownerSuiteId: string;
  secretKey: Uint8Array;
  quantumKey: Uint8Array;
  coreKeys: Record<string, string>;
}): Promise<string> {
  const quantumKeyId = keyIdOfSecret(input.quantumKey);
  const header: PlaintextHeader = {
    category: "iface",
    sensitivity: "P1",
    keyIds: [quantumKeyId],
    schema: { name: "iface.v1", version: "1" },
    fields: [...IFACE_HEADER_FIELDS],
  };

  let lastEnvelopeId = "";
  for (const deviceId of DEVICE_IDS) {
    lastEnvelopeId = await publishEntry({
      dataDir: input.dataDir,
      suiteId: input.suiteId,
      secretKey: input.secretKey,
      quantumKey: input.quantumKey,
      type: "iface.metadata",
      header,
      body: {
        deviceId,
        ops: [...OPS_BY_DEVICE[deviceId]],
        meta: DEVICE_META[deviceId],
        ownerSuiteId: input.ownerSuiteId,
        coreKeys: { ...input.coreKeys },
      },
    });
  }
  return lastEnvelopeId;
}

/** 发布授权条目（perm.grant），授权本体只存在于全局状态量子。 */
export async function publishGrantToQuantum(input: {
  dataDir: string;
  suiteId: string;
  secretKey: Uint8Array;
  quantumKey: Uint8Array;
  subjectId: string;
  ops: readonly string[];
  ttlMs: number;
  extraKeyIds: readonly string[];
}): Promise<string> {
  const quantumKeyId = keyIdOfSecret(input.quantumKey);
  const now = Date.now();
  const header: PlaintextHeader = {
    category: "perm",
    sensitivity: "P1",
    keyIds: [quantumKeyId, ...input.extraKeyIds],
    schema: { name: "perm.v1", version: "1" },
    fields: ["subjectId", "op", "resource", "granteeKeyIds", "notBefore", "notAfter"],
  };

  return publishEntry({
    dataDir: input.dataDir,
    suiteId: input.suiteId,
    secretKey: input.secretKey,
    quantumKey: input.quantumKey,
    type: "perm.grant",
    header,
    body: {
      subjectId: input.subjectId,
      op: [...input.ops],
      resource: [...DEVICE_IDS],
      granteeKeyIds: [quantumKeyId],
      notBefore: now,
      notAfter: now + input.ttlMs,
    },
  });
}
