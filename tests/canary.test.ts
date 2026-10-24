import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDemoServer } from "../apps/demo/src/server.ts";
import type { DemoServer } from "../apps/demo/src/server.ts";

type Json = Record<string, unknown>;

let demo: DemoServer;
let dataDir = "";
let coreId = "";
const canary = `CANARY-${randomUUID()}`;

async function call(pathname: string, body?: Json): Promise<Json> {
  const response = await fetch(`${demo.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Json;
}

async function readAllLines(dir: string): Promise<string[]> {
  const lines: string[] = [];
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return lines;
  }
  for (const name of files.filter((file) => file.endsWith(".jsonl"))) {
    const text = await readFile(path.join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) lines.push(line);
    }
  }
  return lines;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "superpose-canary-"));
  demo = await createDemoServer({ port: 0, suitePort: 0, dataDir });
  await call("/api/core/insert", {});
  const state = await call("/api/state");
  coreId = String(state.coreId);

  const privatized = path.join(dataDir, "cores", coreId, "privatized");
  await mkdir(privatized, { recursive: true });
  await writeFile(
    path.join(privatized, "p3-private.jsonl"),
    `${JSON.stringify({ marker: canary, note: "do-not-leak" })}\n`,
    "utf8",
  );
}, 90_000);

afterAll(async () => {
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("T4 canary 不进入全局状态量子", () => {
  it("三轮对话与两次设备请求后，量子与请求日志均无 canary", async () => {
    for (const text of ["第一轮", "第二轮", "第三轮"]) {
      await call("/api/turn", { text });
    }
    for (const on of [true, false]) {
      const verdict = await call("/api/device", {
        device: "led",
        op: "device.led.set",
        args: { on },
      });
      expect(verdict.ok).toBe(true);
    }
    await call("/api/core/eject", {});

    const quantumLines = await readAllLines(path.join(dataDir, "quantum"));
    expect(quantumLines.length).toBeGreaterThan(0);
    expect(quantumLines.join("\n").includes(canary)).toBe(false);

    const requestLines = await readAllLines(path.join(dataDir, "terminal", "mobilesuite"));
    expect(requestLines.length).toBeGreaterThan(0);
    expect(requestLines.join("\n").includes(canary)).toBe(false);

    const contributions = (
      await readFile(path.join(dataDir, "cores", coreId, "contribute.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(contributions.length).toBeGreaterThan(0);
    for (const line of contributions) {
      expect(JSON.parse(line)).toMatchObject({ selfCheck: true, granted: true });
    }

    // 反向对照：证明 canary 检测本身有效（在临时副本中做，主目录不受污染）
    const copy = await mkdtemp(path.join(tmpdir(), "superpose-canary-copy-"));
    try {
      await mkdir(path.join(copy, "quantum"), { recursive: true });
      for (const line of quantumLines) {
        await appendFile(path.join(copy, "quantum", "fake.jsonl"), `${line}\n`, "utf8");
      }
      await appendFile(
        path.join(copy, "quantum", "fake.jsonl"),
        `${JSON.stringify({ marker: canary })}\n`,
        "utf8",
      );
      const copied = await readAllLines(path.join(copy, "quantum"));
      expect(copied.join("\n").includes(canary)).toBe(true);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 60_000);
});
