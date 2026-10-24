import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { AgentCoreError, dataRoot } from "@superpose/agent-core";
import { b64urlDecode, decodePrivateKey } from "@superpose/protocol";
import type { DeviceId, DeviceOp } from "@superpose/mobile-suite";

import { createEmbody } from "./loop.ts";

function readRequired(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`missing required env ${name}\n`);
    process.exit(2);
  }
  return value;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const coreId = flagValue(process.argv.slice(2), "--core") ?? process.env.SUPERPOSE_CORE_ID ?? "";
if (coreId.length === 0) {
  process.stderr.write("usage: superpose-embody --core <coreId>\n");
  process.exit(2);
}

const pin = process.env.SUPERPOSE_PIN ?? "";
const suiteUrl = process.env.SUPERPOSE_SUITE_URL ?? undefined;

let coreSecretKey: Uint8Array;
let quantumKey: Uint8Array;
try {
  coreSecretKey = decodePrivateKey(readRequired("SUPERPOSE_CORE_SK"));
  quantumKey = b64urlDecode(readRequired("SUPERPOSE_QUANTUM_KEY"));
  if (quantumKey.length !== 32) throw new Error("SUPERPOSE_QUANTUM_KEY must be 32 bytes");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "invalid key material"}\n`);
  process.exit(2);
}

const pidFile = path.join(dataRoot(), "run", "embody.pid");
await mkdir(path.dirname(pidFile), { recursive: true });
await writeFile(pidFile, `${process.pid}\n`, "utf8");
process.on("exit", () => {
  try {
    rmSync(pidFile);
  } catch {
    // pid 文件可能已被清理
  }
});

const embody = createEmbody({
  coreId,
  pin,
  coreSecretKey,
  quantumKey,
  suiteUrl,
  onDecohere: () => {
    // 解相干后 250ms 内退出，且不再写量子
    setTimeout(() => process.exit(0), 0);
  },
});

embody.onEvent((event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
});

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let command: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return;
    command = parsed as Record<string, unknown>;
  } catch {
    process.stderr.write("ignored malformed command\n");
    return;
  }

  if (command.cmd === "turn" && typeof command.text === "string") {
    void embody.turn(command.text).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "turn failed"}\n`);
    });
    return;
  }

  if (command.cmd === "device" && typeof command.op === "string" && typeof command.device === "string") {
    void embody
      .device({
        device: command.device as DeviceId,
        op: command.op as DeviceOp,
        args:
          typeof command.args === "object" && command.args !== null
            ? (command.args as Record<string, unknown>)
            : {},
      })
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : "device failed"}\n`);
      });
  }
});

try {
  await embody.start();
} catch (error) {
  input.close();
  process.exit(error instanceof AgentCoreError && error.code === "E_DECOMP" ? 1 : 2);
}
