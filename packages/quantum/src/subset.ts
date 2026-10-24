import type { Category, PlaintextHeader } from "@superpose/protocol";

import type { QuantumRecord } from "./entry.ts";
import type { QuantumPoint } from "./log.ts";

export type InterpretableEntry = {
  seq: number;
  envelopeId: string;
  sourceKind: QuantumRecord["sourceKind"];
  sourceId: string;
  type: QuantumRecord["type"];
  ts: number;
  corrId: string;
  keyId: string;
  plaintextHeader: PlaintextHeader;
};

export type Adaptation = {
  categories?: readonly Category[];
};

export type InterpretableQuery = {
  keyIds: readonly string[];
  grants: readonly string[];
  adaptation?: Adaptation;
};

/**
 * 计算某终端在某个量子点上的可解读子集。
 *
 * - `keyIds`：终端持有的解密密钥选择器；与条目 `plaintextHeader.keyIds` 无交集即不可解读
 *   （无密钥拿不到任何内容）。
 * - `grants`：授权白名单（`perm.grant` 的 envelopeId）。非空时只暴露白名单内的条目；
 *   空数组表示不按授权过滤。量子本身不判定权限，只做结构过滤。
 * - `adaptation`：终端适配裁剪，目前只支持按合法信息类别过滤。
 *
 * 返回值只含明文头部，永远不含明文正文。
 */
export function interpretableSubset(
  point: QuantumPoint,
  query: InterpretableQuery,
): InterpretableEntry[] {
  const keyIds = new Set(query.keyIds);
  if (keyIds.size === 0) return [];

  const grants = new Set(query.grants);
  const queryCategories = query.adaptation?.categories;
  const categoryFilter =
    queryCategories !== undefined && queryCategories.length > 0
      ? new Set<Category>(queryCategories)
      : undefined;

  const entries: InterpretableEntry[] = [];
  for (const record of point.records) {
    const header = record.entry.plaintextHeader;
    if (categoryFilter !== undefined && !categoryFilter.has(header.category)) continue;
    if (!header.keyIds.some((id) => keyIds.has(id))) continue;
    if (grants.size > 0 && !grants.has(record.envelopeId)) continue;

    entries.push({
      seq: record.seq,
      envelopeId: record.envelopeId,
      sourceKind: record.sourceKind,
      sourceId: record.sourceId,
      type: record.type,
      ts: record.ts,
      corrId: record.corrId,
      keyId: record.entry.keyId,
      plaintextHeader: header,
    });
  }
  return entries;
}
