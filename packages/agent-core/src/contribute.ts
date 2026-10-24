import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { Envelope, PlaintextHeader } from "@superpose/protocol";
import type { QuantumLog } from "@superpose/quantum";

import { AgentCoreError, coreDirOf, loadManifest } from "./manifest.ts";

export const CONTRIBUTABLE_FIELDS = ["identity.public", "session.head", "iface.usage"] as const;

export type ContributableField = (typeof CONTRIBUTABLE_FIELDS)[number];

export async function contribute(
  coreId: string,
  log: QuantumLog,
  input: {
    envelope: Envelope;
    header: PlaintextHeader;
    keyIds: string[];
    field: ContributableField;
    granted: boolean;
  },
): Promise<{ envelopeId: string; selfCheck: boolean; granted: boolean }> {
  // 双判的第一判取自 manifest 自检，绝不放行调用方自述。
  const manifest = await loadManifest(coreId);
  const selfCheck = manifest.contributes.includes(input.field);
  if (!selfCheck) {
    throw new AgentCoreError("E_LEGALITY", `field ${input.field} is not declared in contributes`);
  }
  if (!input.granted) {
    throw new AgentCoreError("E_POLICY", `contribution of ${input.field} was not granted`);
  }

  const record = await log.append(input.envelope, input.header, input.keyIds);
  await appendFile(
    path.join(coreDirOf(coreId), "contribute.jsonl"),
    `${JSON.stringify({
      at: Date.now(),
      field: input.field,
      envelopeId: record.envelopeId,
      selfCheck: true,
      granted: true,
    })}\n`,
    "utf8",
  );

  return { envelopeId: record.envelopeId, selfCheck: true, granted: true };
}
