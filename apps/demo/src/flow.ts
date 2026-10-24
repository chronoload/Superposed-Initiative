import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDemoServer } from "./server.ts";

type Json = Record<string, unknown>;

async function call(base: string, path: string, body?: Json): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

const dataDir = await mkdtemp(path.join(tmpdir(), "superpose-flow-"));
const demo = await createDemoServer({ port: 0, suitePort: 0, dataDir });
const base = demo.url;
const lines: string[] = [];

try {
  const inserted = await call(base, "/api/core/insert", {});
  const coreId = String(inserted.coreId);
  const state1 = await call(base, "/api/state");
  const lifecycle1 = state1.lifecycle as string[];
  const session1 = state1.session as Json;

  lines.push(`[1] insert ${coreId} -> S1_AUTH`);
  lines.push(`[2] auth ok (pin stub) -> S2_CONVERGE`);
  lines.push(
    `[3] converge: agent-core=1 quantum=${String(state1.quantum)} mobile-suite=${String(
      (state1.iface as Json).devices instanceof Array ? ((state1.iface as Json).devices as unknown[]).length : 0,
    )} -> S3_INSTANTIATED`,
  );
  lines.push(`[4] session ${String(session1.sessionId)} turns=${String(session1.turns)}`);

  const turn1 = await call(base, "/api/turn", { text: "你好" });
  lines.push(`[5] turn 1 -> ${String(turn1.text)}`);

  const verdict = await call(base, "/api/device", {
    device: "led",
    op: "device.led.set",
    args: { on: true },
  });
  lines.push(`[6] device device.led.set verdict=${verdict.ok === true ? "ok" : String(verdict.reason)}`);

  const ejected = await call(base, "/api/core/eject", {});
  lines.push(
    `[7] eject -> ${String(ejected.state)} in ${String(ejected.elapsedMs)}ms`,
  );

  await call(base, "/api/provider", { name: "stub-b", model: "stub-2" });
  const reinserted = await call(base, "/api/core/insert", {});
  const state2 = await call(base, "/api/state");
  const lifecycle2 = state2.lifecycle as string[];
  const session2 = state2.session as Json;
  const recovered = lifecycle2.includes("S5_RECOVER");
  lines.push(
    `[8] reinsert ${String(reinserted.coreId)} -> ${recovered ? "S5_RECOVER" : String(state2.state)} session ${String(
      session2.sessionId,
    )} turns=${String(session2.turns)}`,
  );

  const turn2 = await call(base, "/api/turn", { text: "第二轮" });
  lines.push(`[9] turn 2 -> ${String(turn2.text)}`);

  const state3 = await call(base, "/api/state");
  const session3 = state3.session as Json;
  const messages = (session3.messages as unknown[]).length;
  const sameSession = String(session1.sessionId) === String(session3.sessionId);
  const ok =
    String(turn1.text).startsWith("[stub-a] ") &&
    String(turn2.text).startsWith("[stub-b] ") &&
    sameSession &&
    messages === 5 &&
    lifecycle1[0] === "S1_AUTH" &&
    lifecycle1[1] === "S2_CONVERGE" &&
    lifecycle1[2] === "S3_INSTANTIATED";
  lines.push(
    `[10] RESULT: ${ok ? "PASS" : "FAIL"} history=${messages} messages session=${
      sameSession ? "unchanged" : "changed"
    }`,
  );
  for (const line of lines) process.stdout.write(`${line}\n`);
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
} catch (error) {
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `[10] RESULT: FAIL ${error instanceof Error ? error.message : "flow error"}\n`,
  );
  await demo.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
}
