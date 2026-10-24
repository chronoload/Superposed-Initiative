import { b64urlDecode, canonical, verifyBytes } from "@superpose/protocol";
import type { QuantumPoint, QuantumRecord } from "@superpose/quantum";
import { openEntry } from "@superpose/quantum";
import { z } from "zod";

import { zDeviceRequest } from "./device.ts";
import type { DeviceRequest, DeviceVerdict } from "./device.ts";
import { devicesFor } from "./device.ts";

export const MAX_REQUEST_LIFETIME_MS = 30_000;

const zGrantBody = z.object({
  subjectId: z.string().min(1),
  op: z.array(z.string()),
  resource: z.array(z.string()),
  granteeKeyIds: z.array(z.string()),
  notBefore: z.number(),
  notAfter: z.number(),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeRequestId(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const id = (input as { id?: unknown }).id;
    if (typeof id === "string" && UUID_PATTERN.test(id)) return id;
  }
  return globalThis.crypto.randomUUID();
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * 从量子点中的 iface.metadata 条目汇总 coreId -> 签名公钥。
 * 这些条目是本单元自己加密发布的，只有持有 quantumKey 才能解开。
 */
async function collectCoreKeys(
  point: QuantumPoint,
  quantumKey: Uint8Array,
): Promise<Map<string, string>> {
  const coreKeys = new Map<string, string>();
  for (const record of point.records) {
    if (record.type !== "iface.metadata") continue;
    let value: unknown;
    try {
      value = decodeJson(await openEntry(record.entry, quantumKey));
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const declared = (value as { coreKeys?: unknown }).coreKeys;
    if (typeof declared !== "object" || declared === null) continue;
    for (const [coreIdText, publicKey] of Object.entries(declared)) {
      if (typeof publicKey === "string") coreKeys.set(coreIdText, publicKey);
    }
  }
  return coreKeys;
}

function findGrant(point: QuantumPoint, permissionRef: string): QuantumRecord | undefined {
  return point.records.find(
    (record) => record.envelopeId === permissionRef && record.type === "perm.grant",
  );
}

/**
 * 双校验：结构 + 时效 → 量子公布公钥验签 → 量子 perm.grant 权限 → 本地策略 → 执行设备操作。
 * 请求方在 args 里自述的任何权限一律不参与判定。
 */
export async function verifyDeviceRequest(
  input: unknown,
  ctx: {
    now?: number;
    suiteId: string;
    policy: { allow: Record<string, string[]> };
    point: QuantumPoint;
    quantumKey: Uint8Array;
  },
): Promise<DeviceVerdict> {
  const checkedAt = ctx.now ?? Date.now();

  const parsed = zDeviceRequest.safeParse(input);
  if (!parsed.success) {
    return { requestId: safeRequestId(input), ok: false, reason: "E_SIG", checkedAt };
  }
  const request: DeviceRequest = parsed.data;

  const lifetime = request.expiresAt - request.issuedAt;
  if (checkedAt > request.expiresAt || lifetime <= 0 || lifetime > MAX_REQUEST_LIFETIME_MS) {
    return { requestId: request.id, ok: false, reason: "E_STALE", checkedAt };
  }

  const coreKeys = await collectCoreKeys(ctx.point, ctx.quantumKey);
  const publicKeyText = coreKeys.get(request.requester.coreId);
  if (publicKeyText === undefined) {
    return { requestId: request.id, ok: false, reason: "E_SIG", checkedAt };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = b64urlDecode(publicKeyText);
    signature = b64urlDecode(request.sig);
  } catch {
    return { requestId: request.id, ok: false, reason: "E_SIG", checkedAt };
  }
  if (publicKey.length !== 32) {
    return { requestId: request.id, ok: false, reason: "E_SIG", checkedAt };
  }

  const { sig: _sig, ...signedBody } = request;
  const message = new TextEncoder().encode(canonical(signedBody));
  if (!verifyBytes(signature, message, publicKey)) {
    return { requestId: request.id, ok: false, reason: "E_SIG", checkedAt };
  }

  const grantRecord = findGrant(ctx.point, request.permissionRef);
  if (grantRecord === undefined) {
    return { requestId: request.id, ok: false, reason: "E_PERM_UNKNOWN", checkedAt };
  }

  let grantValue: unknown;
  try {
    grantValue = decodeJson(await openEntry(grantRecord.entry, ctx.quantumKey));
  } catch {
    return { requestId: request.id, ok: false, reason: "E_PERM_UNKNOWN", checkedAt };
  }
  const grant = zGrantBody.safeParse(grantValue);
  if (!grant.success) {
    return { requestId: request.id, ok: false, reason: "E_PERM_UNKNOWN", checkedAt };
  }

  if (checkedAt > grant.data.notAfter) {
    return { requestId: request.id, ok: false, reason: "E_PERM_EXPIRED", checkedAt };
  }
  if (
    grant.data.subjectId !== request.requester.coreId ||
    !grant.data.op.includes(request.op) ||
    !grant.data.resource.includes(request.target.deviceId)
  ) {
    return { requestId: request.id, ok: false, reason: "E_OP_NOT_GRANTED", checkedAt };
  }

  const allowed = ctx.policy.allow[request.requester.coreId] ?? [];
  if (!allowed.includes(request.op)) {
    return { requestId: request.id, ok: false, reason: "E_POLICY", checkedAt };
  }

  try {
    devicesFor(ctx.suiteId).apply(request.target.deviceId, request.op, request.args);
  } catch {
    return { requestId: request.id, ok: false, reason: "E_POLICY", checkedAt };
  }

  return { requestId: request.id, ok: true, reason: "ok", checkedAt };
}
