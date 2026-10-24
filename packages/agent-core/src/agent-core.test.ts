import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  b64urlDecode,
  b64urlEncode,
  decodePrivateKey,
  encodePublicKey,
  keyIdOf,
  mintEnvelope,
  publicKeyOf,
  signEnvelope,
} from "@superpose/protocol";
import type { Envelope, PlaintextHeader } from "@superpose/protocol";
import { envelopeAad, keyIdOfSecret, openLog, sealEntry } from "@superpose/quantum";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTRIBUTABLE_FIELDS,
  appendAudit,
  appendTurn,
  assertMounted,
  comparePin,
  contribute,
  coreDirOf,
  dataRoot,
  ejectCore,
  ensureSession,
  isAgentCoreError,
  latestSession,
  loadManifest,
  loadSession,
  mountCore,
  provisionCore,
  readMount,
  readSessionIndex,
} from "./index.ts";
import type {
  ContributableField,
  ProvisionInput,
  ProvisionedCore,
  SessionMessage,
} from "./index.ts";

const QUANTUM_KEY = new Uint8Array(32).fill(7);
const QUANTUM_KEY_ID = keyIdOfSecret(QUANTUM_KEY);
const CORE_SEED = new Uint8Array(32).fill(5);
const PIN = "1234";
const PROVIDER_A = { name: "stub-a", model: "stub-1" };
const PROVIDER_B = { name: "stub-b", model: "stub-2" };

let workDir: string;
let previousData: string | undefined;

beforeEach(async () => {
  previousData = process.env.SUPERPOSE_DATA;
  workDir = await mkdtemp(path.join(tmpdir(), "superpose-agent-core-"));
  process.env.SUPERPOSE_DATA = workDir;
});

afterEach(async () => {
  if (previousData === undefined) delete process.env.SUPERPOSE_DATA;
  else process.env.SUPERPOSE_DATA = previousData;
  await rm(workDir, { recursive: true, force: true });
});

function provision(overrides: Partial<ProvisionInput> = {}): Promise<ProvisionedCore> {
  const input: ProvisionInput = {
    displayName: "测试 Agent Core",
    quantumKeyIds: [QUANTUM_KEY_ID],
    pin: PIN,
    seed: CORE_SEED,
    ...overrides,
  };
  return provisionCore(input);
}

function message(seq: number, role: SessionMessage["role"], text: string): SessionMessage {
  return { seq, role, text, ts: Date.now() };
}

function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function buildContribution(core: ProvisionedCore): Promise<{
  envelope: Envelope;
  header: PlaintextHeader;
  keyIds: string[];
}> {
  const secretKey = decodePrivateKey(core.coreSecretKey);
  const draft = mintEnvelope({
    kind: "agent-core",
    sourceId: core.coreId,
    type: "core.contribute",
    payload: { enc: "plain", body: { field: "session.head" } },
  });
  const sealed = await sealEntry(
    new TextEncoder().encode("contribution-body"),
    QUANTUM_KEY,
    envelopeAad(draft),
  );
  const blob = b64urlDecode(sealed.ciphertext);
  const envelope = signEnvelope(
    {
      ...draft,
      payload: {
        enc: "aead",
        body: {
          keyId: sealed.keyId,
          alg: "xchacha20poly1305",
          nonce: b64urlEncode(blob.slice(0, 24)),
          aad: sealed.aad,
          ciphertext: b64urlEncode(blob.slice(24)),
        },
      },
    },
    secretKey,
  );
  return {
    envelope,
    header: {
      category: "env",
      sensitivity: "P1",
      keyIds: [QUANTUM_KEY_ID],
      schema: { name: "env.v1", version: "1" },
      fields: ["region", "epochMs", "subjects"],
    },
    keyIds: [QUANTUM_KEY_ID],
  };
}

describe("CoreManifest", () => {
  it("provisionCore 建立目录并把公钥写入 manifest 与 keys/pub.json", async () => {
    const core = await provision();

    expect(core.coreId).toMatch(/^core_[0-9a-f]{16}$/);
    expect(core.manifest.coreId).toBe(core.coreId);
    expect(core.manifest.identity.did).toMatch(/^did:superpose:[a-z0-9]{20}$/);
    expect(core.manifest.protocolSubset.legalFields).toHaveLength(15);
    expect(core.manifest.contributes).toEqual([...CONTRIBUTABLE_FIELDS]);
    expect(core.manifest.keys.coreBoxPub).toHaveLength(43);

    const publicKey = publicKeyOf(decodePrivateKey(core.coreSecretKey));
    expect(core.coreKeyId).toBe(keyIdOf(publicKey));
    expect(core.manifest.keys.coreSigningPub).toBe(encodePublicKey(publicKey));

    expect(await loadManifest(core.coreId)).toEqual(core.manifest);

    const pubFile = JSON.parse(
      await readFile(path.join(coreDirOf(core.coreId), "keys", "pub.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pubFile).toEqual({
      coreSigningPub: core.manifest.keys.coreSigningPub,
      coreBoxPub: core.manifest.keys.coreBoxPub,
    });
    expect("coreSecretKey" in pubFile).toBe(false);
  });

  it("manifest 含 model 键被拒为 E_MANIFEST_SHAPE", async () => {
    const core = await provision();
    const manifest = await loadManifest(core.coreId);
    await writeFile(
      path.join(coreDirOf(core.coreId), "manifest.json"),
      JSON.stringify({ ...manifest, model: "gpt-x" }),
      "utf8",
    );

    await expect(loadManifest(core.coreId)).rejects.toMatchObject({ code: "E_MANIFEST_SHAPE" });
  });

  it("manifest 缺失时为 E_SOURCE_MISSING", async () => {
    await expect(loadManifest("core_2222222222222222")).rejects.toMatchObject({
      code: "E_SOURCE_MISSING",
    });
  });
});

describe("mount pointer", () => {
  it("未插卡时 readMount 与 assertMounted 都抛 E_NOT_MOUNTED", async () => {
    const core = await provision();

    expect(isAgentCoreError(captureSync(readMount), "E_NOT_MOUNTED")).toBe(true);
    expect(isAgentCoreError(captureSync(() => assertMounted(core.coreId)), "E_NOT_MOUNTED")).toBe(
      true,
    );
  });

  it("mountCore 写入指针、ejectCore 幂等删除", async () => {
    const core = await provision();
    const pointer = mountCore(core.coreId);

    expect(pointer.coreId).toBe(core.coreId);
    expect(readMount()).toEqual(pointer);
    expect(assertMounted(core.coreId)).toEqual(pointer);

    ejectCore();
    expect(isAgentCoreError(captureSync(readMount), "E_NOT_MOUNTED")).toBe(true);

    ejectCore();
    expect(isAgentCoreError(captureSync(readMount), "E_NOT_MOUNTED")).toBe(true);
  });

  it("指针指向其他 coreId 时 assertMounted 抛 E_NOT_MOUNTED", async () => {
    const core = await provision();
    mountCore(core.coreId);

    expect(
      isAgentCoreError(captureSync(() => assertMounted("core_1111111111111111")), "E_NOT_MOUNTED"),
    ).toBe(true);
  });

  it("manifest 不可读时不写指针", async () => {
    expect(
      isAgentCoreError(captureSync(() => mountCore("core_2222222222222222")), "E_SOURCE_MISSING"),
    ).toBe(true);
    expect(isAgentCoreError(captureSync(readMount), "E_NOT_MOUNTED")).toBe(true);
  });
});

describe("SessionRecord", () => {
  it("同一 Agent Core 的 ensureSession 保持 sessionId 与 createdAt，只更新 provider", async () => {
    const core = await provision();

    expect(await readSessionIndex(core.coreId)).toEqual({ latest: null, all: [] });

    const first = await ensureSession(core.coreId, PROVIDER_A);
    const second = await ensureSession(core.coreId, PROVIDER_B);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.provider).toEqual(PROVIDER_B);
    expect(second.messages).toEqual(first.messages);

    expect(await latestSession(core.coreId)).toEqual(second);
    expect((await loadSession(core.coreId, first.sessionId)).provider.name).toBe("stub-b");
    expect(await readSessionIndex(core.coreId)).toEqual({
      latest: first.sessionId,
      all: [first.sessionId],
    });
  });

  it("appendTurn 重写 json 并追加 jsonl 行", async () => {
    const core = await provision();
    const base = await ensureSession(core.coreId, PROVIDER_A);
    const firstTurn = await appendTurn(core.coreId, {
      ...base,
      updatedAt: base.updatedAt + 1,
      turns: 1,
      messages: [message(0, "user", "你好"), message(1, "assistant", "收到")],
    });

    const logFile = path.join(
      coreDirOf(core.coreId),
      "sessions",
      `${base.sessionId}.jsonl`,
    );
    expect((await readFile(logFile, "utf8")).trim().split("\n")).toHaveLength(2);

    const secondTurn = await appendTurn(core.coreId, {
      ...firstTurn,
      updatedAt: firstTurn.updatedAt + 1,
      turns: 2,
      messages: [...firstTurn.messages, message(2, "user", "再来"), message(3, "assistant", "好")],
    });

    expect(secondTurn.messages).toHaveLength(4);
    expect((await readFile(logFile, "utf8")).trim().split("\n")).toHaveLength(4);
    expect((await latestSession(core.coreId))?.turns).toBe(2);
  });

  it("messages 非前缀扩展时抛 E_SESSION_REWRITE", async () => {
    const core = await provision();
    const base = await ensureSession(core.coreId, PROVIDER_A);
    const saved = await appendTurn(core.coreId, {
      ...base,
      updatedAt: base.updatedAt + 1,
      turns: 1,
      messages: [message(0, "user", "原文"), message(1, "assistant", "回复")],
    });

    await expect(
      appendTurn(core.coreId, {
        ...saved,
        messages: [message(0, "user", "被改写"), ...saved.messages.slice(1)],
      }),
    ).rejects.toMatchObject({ code: "E_SESSION_REWRITE" });

    await expect(
      appendTurn(core.coreId, { ...saved, messages: saved.messages.slice(0, 1) }),
    ).rejects.toMatchObject({ code: "E_SESSION_REWRITE" });
  });

  it("messages 超过 2000 条时抛 E_SESSION_LIMIT", async () => {
    const core = await provision();
    const base = await ensureSession(core.coreId, PROVIDER_A);
    const messages = Array.from({ length: 2001 }, (_, index) => message(index, "user", "填充"));

    await expect(
      appendTurn(core.coreId, { ...base, updatedAt: base.updatedAt + 1, messages }),
    ).rejects.toMatchObject({ code: "E_SESSION_LIMIT" });
  });
});

describe("contribute", () => {
  it("白名单字段在授权后真正写入量子并留下双判记录", async () => {
    const core = await provision();
    const log = openLog(path.join(dataRoot(), "quantum"));
    const built = await buildContribution(core);

    const result = await contribute(core.coreId, log, {
      ...built,
      field: "session.head",
      granted: true,
    });

    expect(result).toEqual({ envelopeId: built.envelope.id, selfCheck: true, granted: true });
    expect((await log.materialize()).records).toHaveLength(1);

    const lines = (
      await readFile(path.join(coreDirOf(core.coreId), "contribute.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      field: "session.head",
      envelopeId: built.envelope.id,
      selfCheck: true,
      granted: true,
    });
  });

  it("contributes 白名单外的字段被拒为 E_LEGALITY 且不写入", async () => {
    const core = await provision();
    const log = openLog(path.join(dataRoot(), "quantum"));
    const built = await buildContribution(core);

    await expect(
      contribute(core.coreId, log, {
        ...built,
        field: "model.weights" as ContributableField,
        granted: true,
      }),
    ).rejects.toMatchObject({ code: "E_LEGALITY" });

    expect((await log.materialize()).records).toHaveLength(0);
    await expect(
      readFile(path.join(coreDirOf(core.coreId), "contribute.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("未授权的贡献被拒为 E_POLICY 且不写入", async () => {
    const core = await provision();
    const log = openLog(path.join(dataRoot(), "quantum"));
    const built = await buildContribution(core);

    await expect(
      contribute(core.coreId, log, { ...built, field: "iface.usage", granted: false }),
    ).rejects.toMatchObject({ code: "E_POLICY" });

    expect((await log.materialize()).records).toHaveLength(0);
  });
});

describe("guard", () => {
  it("正确 PIN 通过，错误 PIN 记为 E_BIO 并累计次数", async () => {
    const core = await provision();

    await expect(comparePin(core.coreId, PIN)).resolves.toEqual({ ok: true });
    await expect(comparePin(core.coreId, "0000")).resolves.toEqual({
      ok: false,
      code: "E_BIO",
      attempts: 1,
    });
  });

  it("连续 3 次 PIN 错误后锁定，锁定期内正确 PIN 也被拒", async () => {
    const core = await provision();

    await expect(comparePin(core.coreId, "0000")).resolves.toMatchObject({
      ok: false,
      code: "E_BIO",
      attempts: 1,
    });
    await expect(comparePin(core.coreId, "0000")).resolves.toMatchObject({
      ok: false,
      code: "E_BIO",
      attempts: 2,
    });
    await expect(comparePin(core.coreId, "0000")).resolves.toEqual({
      ok: false,
      code: "E_LOCKED",
    });
    await expect(comparePin(core.coreId, PIN)).resolves.toEqual({
      ok: false,
      code: "E_LOCKED",
    });

    const lock = JSON.parse(
      await readFile(path.join(coreDirOf(core.coreId), "privatized", "lock.json"), "utf8"),
    ) as { attempts: number; lockedUntil: number };
    expect(lock.attempts).toBe(3);
    expect(lock.lockedUntil).toBeGreaterThan(Date.now());
    expect(lock.lockedUntil).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("appendAudit 逐行追加内部状态动作", async () => {
    const core = await provision();

    await appendAudit(core.coreId, { action: "auth.ok" });
    await appendAudit(core.coreId, { action: "auth.fail", attempts: 2 });

    const lines = (await readFile(path.join(coreDirOf(core.coreId), "audit.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ action: "auth.ok" });
    expect(JSON.parse(lines[1])).toMatchObject({ action: "auth.fail", attempts: 2 });
  });
});
