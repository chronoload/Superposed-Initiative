import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { dataRoot } from "@superpose/agent-core";
import type { DeviceId, DeviceOp } from "@superpose/mobile-suite";

import { createOrchestrator, DemoError } from "./orchestrator.ts";
import type { DemoOrchestrator } from "./orchestrator.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const publicDir = path.resolve(here, "../public");
const embodyEntry = path.join(repoRoot, "packages", "embody", "src", "main.ts");

const MIME: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};

export type DemoServerOptions = { port?: number; suitePort?: number; dataDir?: string };

export type DemoServer = {
  port: number;
  url: string;
  orchestrator: DemoOrchestrator;
  close(): Promise<void>;
};

export async function createDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const dataDir = options.dataDir ?? process.env.SUPERPOSE_DATA ?? dataRoot();
  const orchestrator = createOrchestrator({
    dataDir,
    suitePort: options.suitePort,
    embodyEntry,
    repoRoot,
  });
  await orchestrator.initialize();

  const server = createServer((request, response) => {
    void route(request, response);
  });
  const sockets = new WebSocketServer({ server, path: "/ws" });

  function broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const client of sockets.clients as Set<WebSocket>) {
      if (client.readyState === 1) client.send(text);
    }
  }

  orchestrator.onEvent((event) => {
    broadcast({ type: "event", event });
  });

  function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(text);
  }

  async function sendFile(response: ServerResponse, name: string): Promise<void> {
    const body = await readFile(path.join(publicDir, name));
    response.writeHead(200, {
      "content-type": MIME[name] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  }

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > 1_000_000) throw new DemoError("E_SIG", "request body too large");
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      throw new DemoError("E_SIG", "request body is not JSON");
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        await sendFile(response, "index.html");
        return;
      }
      if (request.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/style.css")) {
        await sendFile(response, url.pathname.slice(1));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, await orchestrator.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/core/insert") {
        sendJson(response, 200, await orchestrator.insert());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/core/eject") {
        const noreap = url.searchParams.get("noreap") === "1";
        sendJson(response, 200, await orchestrator.eject({ noreap }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const body = await readJson(request);
        const text = typeof body.text === "string" ? body.text : "";
        if (text.length === 0) throw new DemoError("E_SIG", "turn text is required");
        sendJson(response, 200, await orchestrator.turn(text));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/device") {
        const body = await readJson(request);
        const device = typeof body.device === "string" ? body.device : "led";
        const op = typeof body.op === "string" ? body.op : "device.led.set";
        sendJson(
          response,
          200,
          await orchestrator.device({
            device: device as DeviceId,
            op: op as DeviceOp,
            args:
              typeof body.args === "object" && body.args !== null
                ? (body.args as Record<string, unknown>)
                : {},
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provider") {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name : "stub-a";
        const model = typeof body.model === "string" ? body.model : undefined;
        sendJson(response, 200, { provider: await orchestrator.provider(name, model) });
        return;
      }
      sendJson(response, 404, { error: "E_NOT_FOUND" });
    } catch (error) {
      const code = error instanceof DemoError ? error.code : "E_INTERNAL";
      const status = code === "E_INTERNAL" ? 500 : code === "E_NOT_FOUND" ? 404 : 409;
      sendJson(response, status, {
        error: code,
        message: error instanceof Error ? error.message : "unknown error",
        stderr: code === "E_INTERNAL" ? (await orchestrator.snapshot()).stderr : undefined,
      });
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 7317, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 7317);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    orchestrator,
    async close() {
      await new Promise<void>((resolve) => {
        for (const client of sockets.clients as Set<WebSocket>) client.terminate();
        sockets.close();
        server.close(() => resolve());
      });
      await orchestrator.close();
    },
  };
}
