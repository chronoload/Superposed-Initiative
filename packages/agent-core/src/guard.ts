import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256hex } from "@superpose/protocol";

import { AgentCoreError, coreDirOf } from "./manifest.ts";

const MAX_PIN_ATTEMPTS = 3;
const LOCK_DURATION_MS = 30_000;

export async function appendAudit(
  coreId: string,
  entry: Record<string, unknown> & { action: string },
): Promise<void> {
  await appendFile(path.join(coreDirOf(coreId), "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

type LockState = { attempts: number; lockedUntil: number };

function privatizedDirOf(coreId: string): string {
  return path.join(coreDirOf(coreId), "privatized");
}

function lockFileOf(coreId: string): string {
  return path.join(privatizedDirOf(coreId), "lock.json");
}

async function readLock(coreId: string): Promise<LockState> {
  try {
    const raw = JSON.parse(await readFile(lockFileOf(coreId), "utf8")) as Partial<LockState>;
    const attempts = typeof raw.attempts === "number" && raw.attempts >= 0 ? raw.attempts : 0;
    const lockedUntil =
      typeof raw.lockedUntil === "number" && raw.lockedUntil >= 0 ? raw.lockedUntil : 0;
    return { attempts, lockedUntil };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

async function writeLock(coreId: string, state: LockState): Promise<void> {
  await mkdir(privatizedDirOf(coreId), { recursive: true });
  await writeFile(lockFileOf(coreId), `${JSON.stringify(state)}\n`, "utf8");
}

/**
 * [stub] PIN 代生物识别：比对 sha256(pin) 与 privatized/pin.digest。
 * 连续 3 次失败即锁定 30s，锁定期间任何 PIN 都拒绝。
 */
export async function comparePin(
  coreId: string,
  pin: string,
): Promise<{ ok: true } | { ok: false; code: "E_BIO" | "E_LOCKED"; attempts?: number }> {
  let digest: string;
  try {
    digest = (await readFile(path.join(privatizedDirOf(coreId), "pin.digest"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentCoreError("E_SOURCE_MISSING", `pin digest for ${coreId} does not exist`);
    }
    throw error;
  }

  const now = Date.now();
  const lock = await readLock(coreId);
  if (lock.lockedUntil > now) return { ok: false, code: "E_LOCKED" };

  const streak = lock.lockedUntil !== 0 && lock.lockedUntil <= now ? 0 : lock.attempts;

  if (sha256hex(pin) === digest) {
    await writeLock(coreId, { attempts: 0, lockedUntil: 0 });
    return { ok: true };
  }

  const attempts = streak + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    await writeLock(coreId, { attempts, lockedUntil: now + LOCK_DURATION_MS });
    return { ok: false, code: "E_LOCKED" };
  }
  await writeLock(coreId, { attempts, lockedUntil: 0 });
  return { ok: false, code: "E_BIO", attempts };
}
