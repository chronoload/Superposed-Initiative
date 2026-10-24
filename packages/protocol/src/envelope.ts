import { z } from "zod";

export const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const b64url64 = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const b64url24 = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const keyId = z.string().regex(/^key_[a-z0-9]{8,32}$/);
export const coreId = z.string().regex(/^core_[0-9a-f]{8,32}$/);
export const suiteId = z.string().regex(/^suite_[0-9a-f]{8,32}$/);
export const embodyId = z.string().regex(/^embody_[0-9a-f]{8,32}$/);

export const ENVELOPE_TYPES = [
  "iface.metadata",
  "device.state",
  "perm.grant",
  "core.contribute",
  "session.head",
  "device.request",
  "device.result",
] as const;

export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

export const zEnvelopeSource = z.object({
  kind: z.enum(["agent-core", "mobile-suite", "embody"]),
  id: z.union([coreId, suiteId, embodyId]),
});

export type EnvelopeSource = z.infer<typeof zEnvelopeSource>;

export const zEnvelopePayload = z.discriminatedUnion("enc", [
  z.object({
    enc: z.literal("plain"),
    body: z.record(z.unknown()),
  }),
  z.object({
    enc: z.literal("aead"),
    body: z.object({
      keyId,
      alg: z.literal("xchacha20poly1305"),
      nonce: b64url24,
      aad: z.string().min(8).max(512),
      ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,}$/),
    }),
  }),
]);

export type EnvelopePayload = z.infer<typeof zEnvelopePayload>;

const SOURCE_PREFIX = {
  "agent-core": "core_",
  "mobile-suite": "suite_",
  embody: "embody_",
} as const;

export const zEnvelope = z
  .object({
    id: z.string().uuid(),
    source: zEnvelopeSource,
    type: z.enum(ENVELOPE_TYPES),
    ts: z.number().int().positive(),
    version: z.literal("0.1"),
    corrId: z.string().uuid(),
    payload: zEnvelopePayload,
    sig: b64url64,
  })
  .superRefine((env, ctx) => {
    if (!env.source.id.startsWith(SOURCE_PREFIX[env.source.kind])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "id"],
        message: "source.id prefix must match source.kind",
      });
    }
  });

export type Envelope = z.infer<typeof zEnvelope>;

export type EnvelopeDraft = Omit<Envelope, "sig">;

export type MintEnvelopeInput = {
  kind: EnvelopeSource["kind"];
  sourceId: string;
  type: EnvelopeType;
  corrId?: string;
  payload: EnvelopePayload;
};

export function mintEnvelope(input: MintEnvelopeInput): EnvelopeDraft {
  const id = globalThis.crypto.randomUUID();
  return {
    id,
    source: { kind: input.kind, id: input.sourceId },
    type: input.type,
    ts: Date.now(),
    version: "0.1",
    corrId: input.corrId ?? id,
    payload: input.payload,
  };
}

export function parseEnvelope(input: unknown): Envelope {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  return zEnvelope.parse(value);
}
