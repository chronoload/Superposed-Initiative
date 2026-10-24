import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonical, coreId as coreIdSchema } from "@superpose/protocol";
import { z } from "zod";

import { AgentCoreError, coreDirOf } from "./manifest.ts";

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

const SESSION_MESSAGE_LIMIT = 2000;

const zProviderSnapshot = z.object({
  name: z.string().min(1).max(32),
  model: z.string().min(1).max(64),
});

export type ProviderSnapshot = z.infer<typeof zProviderSnapshot>;

export const zMessage = z.object({
  seq: z.number().int().nonnegative(),
  role: z.enum(MESSAGE_ROLES),
  text: z.string().min(0).max(8000),
  ts: z.number().int().positive(),
  provider: zProviderSnapshot.optional(),
});

export type SessionMessage = z.infer<typeof zMessage>;

export const zSessionRecord = z.object({
  sessionId: z.string().uuid(),
  coreId: coreIdSchema,
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  schemaVersion: z.literal(1),
  provider: zProviderSnapshot,
  turns: z.number().int().nonnegative(),
  messages: z.array(zMessage).max(SESSION_MESSAGE_LIMIT),
});

export type SessionRecord = z.infer<typeof zSessionRecord>;

const zSessionIndex = z
  .object({
    latest: z.string().uuid().nullable(),
    all: z.array(z.string().uuid()),
  })
  .strict();

function sessionsDir(coreId: string): string {
  return path.join(coreDirOf(coreId), "sessions");
}

function sessionFile(coreId: string, sessionId: string): string {
  return path.join(sessionsDir(coreId), `${sessionId}.json`);
}

function sessionLogFile(coreId: string, sessionId: string): string {
  return path.join(sessionsDir(coreId), `${sessionId}.jsonl`);
}

function indexFile(coreId: string): string {
  return path.join(sessionsDir(coreId), "index.json");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export async function readSessionIndex(
  coreId: string,
): Promise<{ latest: string | null; all: string[] }> {
  let text: string;
  try {
    text = await readFile(indexFile(coreId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { latest: null, all: [] };
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AgentCoreError("E_SESSION_CORRUPT", `session index for ${coreId} is not valid JSON`);
  }
  const parsed = zSessionIndex.safeParse(raw);
  if (!parsed.success) {
    throw new AgentCoreError("E_SESSION_CORRUPT", `session index for ${coreId} has an invalid shape`);
  }
  return { latest: parsed.data.latest, all: [...parsed.data.all] };
}

export async function loadSession(coreId: string, sessionId: string): Promise<SessionRecord> {
  let text: string;
  try {
    text = await readFile(sessionFile(coreId, sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentCoreError("E_SESSION_CORRUPT", `session ${sessionId} does not exist`);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AgentCoreError("E_SESSION_CORRUPT", `session ${sessionId} is not valid JSON`);
  }
  const parsed = zSessionRecord.safeParse(raw);
  if (!parsed.success) {
    throw new AgentCoreError("E_SESSION_CORRUPT", `session ${sessionId} has an invalid shape`);
  }
  return parsed.data;
}

export async function latestSession(coreId: string): Promise<SessionRecord | null> {
  const index = await readSessionIndex(coreId);
  if (index.latest === null) return null;
  return loadSession(coreId, index.latest);
}

export async function ensureSession(
  coreId: string,
  provider: ProviderSnapshot,
): Promise<SessionRecord> {
  const index = await readSessionIndex(coreId);

  if (index.latest === null) {
    const now = Date.now();
    const record: SessionRecord = {
      sessionId: randomUUID(),
      coreId,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      provider,
      turns: 0,
      messages: [],
    };
    const parsed = zSessionRecord.parse(record);
    await writeJsonAtomic(sessionFile(coreId, parsed.sessionId), parsed);
    await writeJsonAtomic(indexFile(coreId), {
      latest: parsed.sessionId,
      all: [...index.all, parsed.sessionId],
    });
    return parsed;
  }

  const record = await loadSession(coreId, index.latest);
  const updated: SessionRecord = { ...record, provider };
  await writeJsonAtomic(sessionFile(coreId, updated.sessionId), updated);
  return updated;
}

export async function appendTurn(coreId: string, record: SessionRecord): Promise<SessionRecord> {
  const previous = await loadSession(coreId, record.sessionId);

  if (record.messages.length < previous.messages.length) {
    throw new AgentCoreError("E_SESSION_REWRITE", "messages may only be appended, never truncated");
  }
  for (let index = 0; index < previous.messages.length; index += 1) {
    const before = previous.messages[index];
    const after = record.messages[index];
    if (canonical(before) !== canonical(after)) {
      throw new AgentCoreError("E_SESSION_REWRITE", `message ${index} was rewritten`);
    }
  }
  if (record.messages.length > SESSION_MESSAGE_LIMIT) {
    throw new AgentCoreError("E_SESSION_LIMIT", `messages exceed the ${SESSION_MESSAGE_LIMIT} cap`);
  }

  const parsed = zSessionRecord.safeParse(record);
  if (!parsed.success) {
    throw new AgentCoreError("E_SESSION_CORRUPT", `session ${record.sessionId} has an invalid shape`);
  }

  const next = parsed.data;
  const added = next.messages.slice(previous.messages.length);
  await writeJsonAtomic(sessionFile(coreId, next.sessionId), next);
  if (added.length > 0) {
    await appendFile(
      sessionLogFile(coreId, next.sessionId),
      added.map((message) => `${JSON.stringify(message)}\n`).join(""),
      "utf8",
    );
  }

  const index = await readSessionIndex(coreId);
  const all = index.all.includes(next.sessionId) ? index.all : [...index.all, next.sessionId];
  await writeJsonAtomic(indexFile(coreId), {
    latest: index.latest ?? next.sessionId,
    all,
  });

  return next;
}
