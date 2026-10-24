import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonical, sha256hex } from "../packages/protocol/src/index.ts";

import { createDemoServer } from "../apps/demo/src/server.ts";
import type { DemoServer } from "../apps/demo/src/server.ts";

type Json = Record<string, unknown>;

let demo: DemoServer;
let dataDir = "";

async function call(pathname: string, body?: Json): Promise<Json> {
  const response = await fetch(`${demo.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Json;
}

async function writeProvider(name: string, model: string): Promise<void> {
  const file = path.join(dataDir, "config", "provider.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ name, model })}\n`, "utf8");
}

type Snapshot = {
  sessionId: string;
  createdAt: number;
  turns: number;
  hash: string;
  provider: string;
  messages: number;
};

async function snapshot(): Promise<Snapshot> {
  const state = await call("/api/state");
  const session = state.session as Json;
  const messages = session.messages as Json[];
  return {
    sessionId: String(session.sessionId),
    createdAt: Number(session.createdAt),
    turns: Number(session.turns),
    hash: sha256hex(canonical(messages.slice(0, 3))),
    provider: String((session.provider as Json).name),
    messages: messages.length,
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-provider-"));
  await writeProvider("stub-a", "stub-1");
  demo = await createDemoServer({ port: 0, suitePort: 0, dataDir });
}, 90_000);

afterAll(async () => {
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("T5 换 provider 后 session id 与历史不变", () => {
  it("身份与会话在刚体更替后保持，前缀切换到 stub-b", async () => {
    await call("/api/core/insert", {});
    for (const text of ["一", "二", "三"]) {
      const turn = await call("/api/turn", { text });
      expect(String(turn.text).startsWith("[stub-a] ")).toBe(true);
    }

    const before = await snapshot();
    expect(before.turns).toBe(3);
    expect(before.provider).toBe("stub-a");

    const ejected = await call("/api/core/eject", {});
    expect(ejected.state).toBe("S4_DECOHERED");

    await writeProvider("stub-b", "stub-2");
    await call("/api/core/insert", {});

    const after = await snapshot();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.turns).toBe(before.turns);
    expect(after.hash).toBe(before.hash);
    expect(after.provider).toBe("stub-b");

    const next = await call("/api/turn", { text: "四" });
    expect(String(next.text).startsWith("[stub-b] ")).toBe(true);
    expect(next.turns).toBe(4);

    const finalState = await call("/api/state");
    const session = finalState.session as Json;
    expect((session.messages as unknown[]).length).toBe(after.messages + 2);

    const index = JSON.parse(
      await readFile(
        path.join(dataDir, "cores", String(finalState.coreId), "sessions", "index.json"),
        "utf8",
      ),
    ) as { all: string[] };
    expect(index.all.length).toBe(1);
  }, 60_000);
});
