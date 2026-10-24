import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export function requestsLogPath(dataDir: string): string {
  return path.join(dataDir, "terminal", "mobilesuite", "requests.jsonl");
}

/**
 * 每次设备请求只写一行，字段白名单固定：
 * 绝不写 args 正文、会话内容或上下文。
 */
export async function appendRequestLog(
  dataDir: string,
  line: Record<string, unknown>,
): Promise<void> {
  const file = requestsLogPath(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const record = {
    requestId: line.requestId,
    op: line.op,
    verdict: line.verdict,
    reason: line.reason,
    checkedAt: line.checkedAt,
  };
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}
