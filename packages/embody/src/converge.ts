import path from "node:path";

import { AgentCoreError, ensureSession, loadManifest } from "@superpose/agent-core";
import type { CoreManifest, ProviderSnapshot, SessionRecord } from "@superpose/agent-core";
import { decodePublicKey } from "@superpose/protocol";
import { openEntry, openLog } from "@superpose/quantum";
import type { QuantumPoint, QuantumRecord } from "@superpose/quantum";

export type SuiteIfaceResponse = {
  iface: {
    suiteId: string;
    ownerSuiteId: string;
    schema: { name: string; version: string };
    devices: Array<{ deviceId: string; ops: string[]; meta: Record<string, unknown> }>;
    coreKeys: Record<string, string>;
    suitePublicKey: string;
  };
  state: Array<{ deviceId: string; state: Record<string, unknown>; observedAt: number }>;
};

/** 三类源（Agent Core / Mobile Suite / 全局状态量子）三源收敛的结果。 */
export type Convergence = {
  manifest: CoreManifest;
  provider: ProviderSnapshot;
  iface: SuiteIfaceResponse;
  point: QuantumPoint;
  permGrantId: string | null;
  degraded: boolean;
  missingDevices: string[];
  session: SessionRecord;
};

export type ConvergeInput = {
  coreId: string;
  dataDir: string;
  provider: ProviderSnapshot;
  suiteUrl: string;
  quantumKey: Uint8Array;
};

/** 可选设备类别：缺失只降级，不阻止启动。 */
export const OPTIONAL_DEVICES = ["display", "sensor"] as const;

function bytesToJson(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentCoreError("E_SOURCE_MISSING", "quantum payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

async function fetchIface(suiteUrl: string): Promise<SuiteIfaceResponse> {
  let response: Response;
  try {
    response = await fetch(`${suiteUrl}/iface`, { method: "GET" });
  } catch {
    throw new AgentCoreError("E_SOURCE_MISSING", "mobile suite iface is unreachable");
  }
  if (!response.ok) {
    throw new AgentCoreError("E_SOURCE_MISSING", `mobile suite iface returned ${response.status}`);
  }
  const body = (await response.json()) as Partial<SuiteIfaceResponse>;
  if (body.iface === undefined || body.state === undefined) {
    throw new AgentCoreError("E_SOURCE_MISSING", "mobile suite iface payload is incomplete");
  }
  return body as SuiteIfaceResponse;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const pool = new Set(left);
  return right.every((value) => pool.has(value));
}

async function decrypt(
  record: QuantumRecord,
  quantumKey: Uint8Array,
): Promise<Record<string, unknown> | null> {
  try {
    return bytesToJson(await openEntry(record.entry, quantumKey));
  } catch {
    return null;
  }
}

/**
 * §4.3 三源收敛：A = CoreManifest，B = 全局状态量子，C = Mobile Suite 接口。
 * 任一源缺失或无法收敛 → 抛 AgentCoreError，由调用方进入 SX_REJECTED。
 */
export async function converge(input: ConvergeInput): Promise<Convergence> {
  // ① A：Agent Core 自我描述
  const manifest = await loadManifest(input.coreId);
  if (manifest.protocolSubset.baseline !== "0.1") {
    throw new AgentCoreError("E_VERSION", "manifest baseline is not 0.1");
  }
  try {
    decodePublicKey(manifest.keys.coreSigningPub);
  } catch {
    throw new AgentCoreError("E_SIG", "manifest coreSigningPub is not a valid key");
  }

  // ② C：Mobile Suite 接口
  const iface = await fetchIface(input.suiteUrl);
  if (iface.iface.schema.version !== "1") {
    throw new AgentCoreError("E_VERSION", "iface schema version mismatch");
  }
  if (iface.iface.ownerSuiteId !== iface.iface.suiteId) {
    throw new AgentCoreError("E_SOURCE_MISSING", "iface ownerSuiteId does not match suiteId");
  }
  try {
    decodePublicKey(iface.iface.suitePublicKey);
  } catch {
    throw new AgentCoreError("E_SIG", "iface suitePublicKey is not a valid key");
  }
  if (
    !sameSet(
      iface.iface.devices.map((device) => device.deviceId),
      iface.state.map((entry) => entry.deviceId),
    )
  ) {
    throw new AgentCoreError("E_SOURCE_MISSING", "iface and state device sets disagree");
  }

  // ③ B：全局状态量子只能经公共 API 读
  const point = await openLog(path.join(input.dataDir, "quantum")).materialize();
  const reachable = point.records.filter((record) =>
    record.entry.plaintextHeader.keyIds.some((keyId) => manifest.keyIds.includes(keyId)),
  );
  if (reachable.length === 0) {
    throw new AgentCoreError("E_SOURCE_MISSING", "no quantum entry reachable by this Agent Core");
  }

  // iface.metadata 必须指向同一个 Mobile Suite
  const ifaceRecords = reachable.filter((record) => record.type === "iface.metadata");
  if (ifaceRecords.length === 0) {
    throw new AgentCoreError("E_SOURCE_MISSING", "no iface.metadata entry in quantum");
  }
  for (const record of ifaceRecords) {
    const body = await decrypt(record, input.quantumKey);
    if (body === null) throw new AgentCoreError("E_SIG", "iface.metadata cannot be decrypted");
    if (body.ownerSuiteId !== iface.iface.suiteId) {
      throw new AgentCoreError("E_SOURCE_MISSING", "iface.metadata ownerSuiteId disagrees with iface");
    }
  }

  // 最近的、仍然有效的权限条目
  const now = Date.now();
  let permGrantId: string | null = null;
  for (const record of reachable) {
    if (record.type !== "perm.grant") continue;
    const body = await decrypt(record, input.quantumKey);
    if (body === null) continue;
    if (body.subjectId !== input.coreId) continue;
    if (typeof body.notAfter === "number" && now > body.notAfter) continue;
    permGrantId = record.envelopeId;
  }

  const present = new Set(iface.iface.devices.map((device) => device.deviceId));
  const missingDevices = OPTIONAL_DEVICES.filter((deviceId) => !present.has(deviceId));

  const session = await ensureSession(input.coreId, input.provider);

  return {
    manifest,
    provider: input.provider,
    iface,
    point,
    permGrantId,
    degraded: missingDevices.length > 0,
    missingDevices: [...missingDevices],
    session,
  };
}
