import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { coreId as coreIdSchema } from "@superpose/protocol";
import { z } from "zod";

import { AgentCoreError, coreDirOf, dataRoot, zCoreManifest } from "./manifest.ts";

export type MountPointer = { coreId: string; mountedAt: number };

const zMountPointer = z
  .object({
    coreId: coreIdSchema,
    mountedAt: z.number().int().positive(),
  })
  .strict();

function pointerPath(): string {
  return path.join(dataRoot(), "terminal", "mount", "core.json");
}

/** 插卡语义唯一依赖该指针文件：存在即已插入，删除即拔卡。 */
export function readMount(): MountPointer {
  let text: string;
  try {
    text = readFileSync(pointerPath(), "utf8");
  } catch {
    throw new AgentCoreError("E_NOT_MOUNTED", "mount pointer is missing");
  }
  try {
    return zMountPointer.parse(JSON.parse(text));
  } catch {
    throw new AgentCoreError("E_NOT_MOUNTED", "mount pointer is corrupt");
  }
}

export function assertMounted(coreId: string): MountPointer {
  const pointer = readMount();
  if (pointer.coreId !== coreId) {
    throw new AgentCoreError("E_NOT_MOUNTED", `mount pointer points to ${pointer.coreId}`);
  }
  return pointer;
}

// mountCore 是同步签名，因此这里用同步读取复用 loadManifest 的校验口径。
function assertManifestReadable(coreId: string): void {
  let text: string;
  try {
    text = readFileSync(path.join(coreDirOf(coreId), "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentCoreError("E_SOURCE_MISSING", `manifest for ${coreId} does not exist`);
    }
    throw error;
  }
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
}

export function mountCore(coreId: string): MountPointer {
  assertManifestReadable(coreId);
  const pointer: MountPointer = { coreId, mountedAt: Date.now() };
  const file = pointerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(pointer)}\n`, "utf8");
  renameSync(temp, file);
  return pointer;
}

export function ejectCore(): void {
  rmSync(pointerPath(), { force: true });
}
