import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ProviderSnapshot, SessionMessage } from "@superpose/agent-core";

export type ProviderMessage = { role: SessionMessage["role"]; text: string };

export type Provider = {
  name: string;
  model: string;
  chat(messages: readonly ProviderMessage[], signal?: AbortSignal): Promise<string>;
};

export const PROVIDER_CONFIG_FILE = path.join("config", "provider.json");

export const DEFAULT_PROVIDER: ProviderSnapshot = { name: "stub-a", model: "stub-1" };

export function providerConfigPath(dataDir: string): string {
  return path.join(dataDir, PROVIDER_CONFIG_FILE);
}

export function loadProviderConfig(dataDir: string): ProviderSnapshot {
  const file = providerConfigPath(dataDir);
  if (!existsSync(file)) return { ...DEFAULT_PROVIDER };
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ProviderSnapshot>;
  return {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : DEFAULT_PROVIDER.name,
    model: typeof raw.model === "string" && raw.model.length > 0 ? raw.model : DEFAULT_PROVIDER.model,
  };
}

export function saveProviderConfig(dataDir: string, snapshot: ProviderSnapshot): void {
  const file = providerConfigPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

function lastUserText(messages: readonly ProviderMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "user") return message.text;
  }
  return "";
}

/**
 * 模型是耗材：provider 只做推理/生成，不持有会话；会话永远留在 Agent Core。
 * stub-a / stub-b 是可替换的确定性实现，用于证明换 provider 不改身份与历史。
 */
export function createProvider(snapshot: ProviderSnapshot): Provider {
  const name = snapshot.name;
  return {
    name,
    model: snapshot.model,
    async chat(messages, signal) {
      if (signal?.aborted === true) throw new Error("provider aborted");
      const prompt = lastUserText(messages);
      if (name === "stub-a" || name === "stub-b") return `[${name}] ${prompt}`;
      throw new Error(`unknown provider: ${name}`);
    },
  };
}
