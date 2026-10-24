import { createDemoServer } from "./server.ts";

const port = Number(process.env.PORT ?? 7317);
const suitePort = Number(process.env.SUPERPOSE_SUITE_PORT ?? 7318);

const demo = await createDemoServer({ port, suitePort });
process.stdout.write(`Superpose demo running at ${demo.url}\n`);
process.stdout.write(`Mobile Suite is on port ${suitePort}\n`);

async function shutdown(): Promise<void> {
  await demo.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
