import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type Policy = { allow: Record<string, string[]> };

export function policyPath(dataDir: string): string {
  return path.join(dataDir, "terminal", "mobilesuite", "policy.json");
}

function sanitize(value: unknown): Policy {
  const allow: Record<string, string[]> = {};
  if (typeof value !== "object" || value === null) return { allow };
  const rawAllow = (value as { allow?: unknown }).allow;
  if (typeof rawAllow !== "object" || rawAllow === null) return { allow };
  for (const [subjectId, ops] of Object.entries(rawAllow)) {
    if (Array.isArray(ops) && ops.every((op) => typeof op === "string")) {
      allow[subjectId] = [...ops];
    }
  }
  return { allow };
}

/** 缺失或损坏一律回退为「无任何允许」，即失败关闭。 */
export function loadPolicy(dataDir: string): Policy {
  const file = policyPath(dataDir);
  if (!existsSync(file)) return { allow: {} };
  try {
    return sanitize(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { allow: {} };
  }
}

/** 原子写：临时文件 + rename。 */
export function savePolicy(dataDir: string, policy: { allow: Record<string, string[]> }): void {
  const file = policyPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${globalThis.crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ allow: policy.allow }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
