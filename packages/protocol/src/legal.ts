import { z } from "zod";
import { keyId } from "./envelope.ts";

export const LEGAL_CATEGORIES = ["env", "perm", "iface", "device"] as const;
export type Category = (typeof LEGAL_CATEGORIES)[number];

export const SENSITIVITY = ["P0", "P1", "P2", "P3", "P4"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

export const SCHEMA_NAMES = ["env.v1", "perm.v1", "iface.v1", "device.v1"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const zPlaintextHeader = z.object({
  category: z.enum(LEGAL_CATEGORIES),
  sensitivity: z.enum(SENSITIVITY),
  keyIds: z.array(keyId).min(1).max(8),
  schema: z.object({
    name: z.enum(SCHEMA_NAMES),
    version: z.literal("1"),
  }),
  fields: z.array(z.string().min(1).max(32)).min(1).max(16),
});

export type PlaintextHeader = z.infer<typeof zPlaintextHeader>;

export const REQUIRED_FIELDS: Record<Category, readonly string[]> = {
  env: ["region", "epochMs", "subjects"],
  perm: ["subjectId", "op", "resource", "granteeKeyIds", "notBefore", "notAfter"],
  iface: ["deviceId", "ops", "meta", "ownerSuiteId"],
  device: ["deviceId", "state", "observedAt"],
};

export const SCHEMA_FOR_CATEGORY: Record<Category, SchemaName> = {
  env: "env.v1",
  perm: "perm.v1",
  iface: "iface.v1",
  device: "device.v1",
};

export type ProtocolSubset = {
  legalFields: readonly string[];
};

export type LegalVerdict =
  | { ok: true }
  | {
      ok: false;
      code: "E_LEGALITY" | "E_CATEGORY_MISMATCH" | "E_FIELDS_MISSING" | "E_KEYIDS_EMPTY" | "E_VERSION";
    };

function reject(code: Extract<LegalVerdict, { ok: false }>["code"]): LegalVerdict {
  return { ok: false, code };
}

export function isLegal(header: PlaintextHeader, subset: ProtocolSubset): LegalVerdict {
  if (!LEGAL_CATEGORIES.includes(header.category)) return reject("E_LEGALITY");
  if (header.schema.name !== SCHEMA_FOR_CATEGORY[header.category]) return reject("E_CATEGORY_MISMATCH");
  if (header.schema.version !== "1") return reject("E_VERSION");

  const legalFields = new Set(subset.legalFields);
  for (const name of header.fields) {
    if (!legalFields.has(name)) return reject("E_LEGALITY");
  }

  const present = new Set(header.fields);
  for (const name of REQUIRED_FIELDS[header.category]) {
    if (!present.has(name)) return reject("E_FIELDS_MISSING");
  }

  if (header.keyIds.length < 1) return reject("E_KEYIDS_EMPTY");
  return { ok: true };
}
