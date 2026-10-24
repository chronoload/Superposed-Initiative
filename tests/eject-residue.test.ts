import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function quantumLines(): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(path.join(dataDir, "quantum"));
  } catch {
    return 0;
  }
  let lines = 0;
  for (const name of files.filter((file) => file.endsWith(".jsonl"))) {
    const text = await readFile(path.join(dataDir, "quantum", name), "utf8");
    lines += text.split("\n").filter((line) => line.trim().length > 0).length;
  }
  return lines;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-eject-"));
  demo = await createDemoServer({ port: 0, suitePort: 0, dataDir });
}, 90_000);

afterAll(async () => {
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("T3 拔卡后无 Embody 残留", () => {
  it("Embody 自发退出，量子零新增，会话留存", async () => {
    await call("/api/core/insert", {});

    let pid = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await exists(path.join(dataDir, "run", "embody.pid"))) {
        pid = Number((await readFile(path.join(dataDir, "run", "embody.pid"), "utf8")).trim());
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    const linesBefore = await quantumLines();
    await call("/api/core/eject?noreap=1", {});

    let diedAfterMs = -1;
    const started = Date.now();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (!alive(pid)) {
        diedAfterMs = Date.now() - started;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(diedAfterMs).toBeGreaterThanOrEqual(0);
    expect(diedAfterMs).toBeLessThan(2000);

    expect(await exists(path.join(dataDir, "run", "embody.pid"))).toBe(false);
    expect(await exists(path.join(dataDir, "terminal", "mount", "core.json"))).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await quantumLines()).toBe(linesBefore);

    const decohere = (await readFile(path.join(dataDir, "run", "decohere.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(decohere.length).toBe(1);
    expect(JSON.parse(decohere[0] as string)).toMatchObject({
      reason: "mount-vanished",
      lateWrites: 0,
    });

    const state = await call("/api/state");
    const coreId = String(state.coreId);
    const sessions = await readdir(path.join(dataDir, "cores", coreId, "sessions"));
    expect(sessions.filter((file) => file.endsWith(".json")).length).toBeGreaterThanOrEqual(1);

    const finalState = await call("/api/state");
    expect(finalState.state).toBe("S4_DECOHERED");
  }, 60_000);
});
