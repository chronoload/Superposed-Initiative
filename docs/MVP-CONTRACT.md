# Superpose MVP 实现契约 v1.0

本文件是 6 个实现单元并行开工的唯一事实源。任何实现细节冲突，以本文件为准；本文件未规定且影响跨单元接口的事项，由评审单元裁定后提升为本文件条款。

## 0. 范围、命名与栈

### 0.1 MVP 只证明这一条论点

插卡即实例化、拔卡即退相干、模型是耗材（换 provider 会话不丢）。

四句话展开为唯一可演示闭环：

1. 未插入 Agent Core 时只有 Mobile Suite 存活，无 agent 运行态。
2. 插入 Agent Core → 鉴权 → 三源汇合 → 实例化 → agent loop 运行 → 可发起设备请求。
3. 拔掉 Agent Core → 运行态即时消失、与全局状态量子退相干、运行时会话不存在。
4. 会话信息留存 Agent Core；重插后恢复同一 `sessionId` 与同一段历史；更换 provider 不改身份、不改历史。

### 0.2 明确出范围（不实现、不建目录、不写占位）

硬件、固件、生物识别真机、MCP、Jev、训练闭环、联赛/市场、Bench、多 OS 适配矩阵、中心内核、数据中枢、模型权重托管。

生物验证一律为 **PIN/口令 stub**，代码与文档中必须标注 `[stub]`，不得伪装成真生物识别。

### 0.3 技术栈（锁定，禁止替换或新增）

| 项 | 规定 |
|---|---|
| 包管理 | pnpm workspace |
| 运行时 | Node 24（`>=24.0.0`），ESM only（根 `package.json` 置 `"type": "module"`） |
| 语言 | TypeScript strict，`noEmit`，无构建步骤（依赖 Node 24 原生类型擦除直接跑 `.ts`） |
| 校验 | `zod` |
| 密码学 | `@noble/ed25519`、`@noble/hashes`、`@noble/ciphers` |
| 网络 | `ws`；其余 HTTP 用 `node:http` |
| 测试 | `vitest` |
| 存储 | 仅文件系统 + JSONL。**禁止数据库、禁止原生（native）模块、禁止任何 `node-gyp` 依赖** |

### 0.4 无构建步骤的硬性后果（实现者必读）

- 所有 import 必须写全扩展名：`import { mint } from "./envelope.ts";`
- 只允许可擦除语法：**禁止 `enum`、`namespace`、构造函数参数属性、`declare` 之外的 TS 运行时特性**。用 `as const` 对象 + 联合类型代替 `enum`。
- 每个包的 `package.json` 用 `"exports": { ".": "./src/index.ts" }`，`"main": "./src/index.ts"`，`"types": "./src/index.ts"`。
- 根 `tsconfig.json` 单份，`include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "apps/*/test/**/*.ts", "tests/**/*.ts"]`，关键编译项：`strict`、`noEmit`、`allowImportingTsExtensions`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`moduleResolution: "bundler"`、`target: "ES2023"`、`module: "ESNext"`。
- 类型检查一条命令：`pnpm typecheck`（= `tsc --noEmit`）。

### 0.5 命名纪律（评审单元逐条机检）

| 必须写 | 禁止写 |
|---|---|
| Agent Core | 单写 Core（`coreId`、`CoreManifest`、`agent-core` 包名属既有标识符，允许） |
| Embody | Harness |
| Mobile Suite | Carrier |
| 全局状态量子 | 环境投影 |
| Valid Space / 信息空间 | 状态写入空间 |

评审单元必须对 `docs/`、`packages/`、`apps/`、`tests/` 全文 grep，命中即打回。允许出现的位置仅限 "禁止写" 一列本身。

### 0.6 运行时目录（不入库）

```
data/                      # .gitignore 忽略，运行时生成
├── cores/<coreId>/        # Agent Core 自身存储（拔卡后仍存在，但不可达）
│   ├── manifest.json
│   ├── keys/              # 本 MVP 只放公钥，私钥由测试夹具注入
│   ├── privatized/        # P2/P3：pin.digest、p3-private.jsonl（含 canary）
│   ├── sessions/
│   │   ├── index.json     # { latest: sessionId, all: sessionId[] }
│   │   └── <sessionId>.json
│   ├── audit.jsonl        # 涉及 Agent Core 内部状态的动作
│   └── contribute.jsonl   # 向全局状态量子贡献的双判记录
├── quantum/quantum.jsonl  # 全局状态量子的唯一持久化载体（append-only 哈希链）
├── terminal/
│   ├── mount/core.json    # 「插卡」指针：{ coreId, mountedAt }，删除即拔卡
│   └── mobilesuite/
│       ├── policy.json
│       └── requests.jsonl
├── config/provider.json   # { name, model }
└── run/{embody.pid,decohere.log}
```

**插卡/拔卡的唯一语义**：`data/terminal/mount/core.json` 存在 = 已插入；删除该文件 = 拔卡。Agent Core 的全部读取必须经 `mount.resolve()`，指针缺失或指向其他 `coreId` 时抛 `E_NOT_MOUNTED`。跨平台、无符号链接、无管理员权限。

---

## 1. 组件边界与依赖方向

### 1.1 依赖图（单向，禁止循环）

```
                    @superpose/protocol
                            ▲
              ┌─────────────┼─────────────────┐
              │             │                 │
    @superpose/quantum      │                 │
         ▲    ▲             │                 │
         │    └─────────────┼──┐              │
         │                  │  │              │
@superpose/agent-core       │  │   @superpose/mobile-suite
         ▲                  │  │              ▲
         │                  │  │              │
         └──────────┬───────┴──┴──────────────┘
                    │
             @superpose/embody
                    ▲
             @superpose/demo  (apps/demo)
```

| 包 | 依赖（只允许向右/向上列出的） |
|---|---|
| `@superpose/protocol` | 无 |
| `@superpose/quantum` | protocol |
| `@superpose/agent-core` | protocol, quantum |
| `@superpose/mobile-suite` | protocol, quantum |
| `@superpose/embody` | protocol, quantum, agent-core, mobile-suite |
| `apps/demo` | 以上全部 |

硬性规则：

- `agent-core` **不得** import `mobile-suite`，反之亦然。两者互不可见，只经 protocol 消息与量子条目通信。
- `protocol` **不得** import 任何其他 workspace 包；不得 import `node:fs`（纯函数包，只做结构与密码学判定）。
- `quantum` **不得** import `agent-core` / `mobile-suite` / `embody`。
- 只有 `apps/demo` 允许 import 全部；`embody` 不得 import `apps/demo`。
- 根脚本 `pnpm verify:deps` 解析各 `package.json` 的 `dependencies` 与源码 import，任一越界或成环即非零退出。

### 1.2 每个单元的职责与禁区

**`@superpose/protocol`** — 合法信息判定的唯一执行者。
- 提供：`Envelope` 结构、canonical 序列化、ed25519 签/验、密钥编解码、四个合法信息类别的判定函数、错误码枚举。
- 判定只看 `plaintextHeader`，**永不解密正文**（SPEC-PR-014）。
- 禁区：不读写文件、不含业务状态、不含 UI 文案。

**`@superpose/quantum`** — 全局状态量子。
- 提供：`seal`/`open`（XChaCha20-Poly1305）、append-only 哈希链日志、`materialize()` 把日志折叠为当前**一个点**、`interpretableSubset()` 计算某终端的可解读子集。
- 全局状态量子是 Valid Space 中的一个点；`materialize()` 返回该点，日志只是它的重放载体。
- 禁区：不判断哪个 `Agent Core` 有权限（权限判定归 protocol 的 `perm` 类别 + Mobile Suite 本地策略比对），不认识 `Agent Core` 的任何私有字段。
- 门禁：任何写入先过 `protocol.isLegal()`；非法条目抛错且不落盘。

**`@superpose/agent-core`** — 物理载体 + 大脑 + 独立信息来源。
- 提供：`CoreManifest` 读写、mount 指针解析、`SessionRecord` 持久化与恢复、向全局状态量子贡献（白名单 + 双判记录）、内部状态动作审计、PIN 比对 `[stub]` 与失败锁定。
- 禁区：不实现 agent loop、不发设备请求、不存模型参数、不存系统数据、不写 `data/quantum/`（贡献只经 `quantum.append` 的公共 API）。

**`@superpose/mobile-suite`** — 系统共用公共接口中间层。
- 提供：设备模拟（led / display / sensor）、静态接口元数据 + 动态设备状态快照（三源中的第三源）、远程请求双校验（验签 + 本地策略比对）、请求日志。
- 禁区：不承载 agent loop、不持久化主体化数据、不成为信任根、不读写 `data/cores/`。

**`@superpose/embody`** — 终端具身 agent 系统（独立进程）。
- 提供：鉴权编排、三源汇合、agent loop、provider 适配、mount 看门狗、退相干执行。
- 禁区：不直接读写量子日志文件（只经 `quantum` API）、不实现设备能力、不持久化会话（会话归 `Agent Core`）。

**`apps/demo`** — 单页可视化 + 编排。
- 提供：HTTP API、WebSocket 实时状态、`Agent Core` 插拔按钮、`Embody` 子进程生命周期、`pnpm demo:flow` 自动化演示。
- 禁区：不含业务判定逻辑，只调用其他包。

---

## 2. 精确文件树

每个单元文件数 ≤9（含 `package.json` 与该单元自己的测试）。下表合计 48 个实现文件 + 4 个根文件 + 1 个评审文件。

```
superpose/
├── package.json                       # 根：workspace 脚本 typecheck/test/demo/demo:flow/verify:deps/test:accept
├── pnpm-workspace.yaml                # packages: ["packages/*", "apps/*"]
├── tsconfig.json                      # 单份全局 TS 配置（0.4 节所列编译项）
├── vitest.config.ts                   # vitest：include ["packages/**/*.test.ts","apps/**/test/**/*.ts","tests/**/*.ts"]
├── .gitignore                         # node_modules/ data/ *.log
├── scripts/check-deps.mjs             # 依赖方向与成环检查（verify:deps）
├── docs/MVP-CONTRACT.md               # 本文件
├── docs/MVP-REVIEW.md                 # U7 产出：评审结论、五条验收原始输出、打回清单
│
├── packages/protocol/                 # U1  9 文件
│   ├── package.json                   # 包元数据，无 dependencies
│   └── src/
│       ├── index.ts                   # 统一再导出
│       ├── codes.ts                   # 错误码与拒绝原因常量（as const 联合）
│       ├── canonical.ts               # canonical JSON（键排序+无空白）、sha256、base64url 编解码
│       ├── keys.ts                    # ed25519 公/私钥编解码、keyId 派生、密钥环结构
│       ├── sign.ts                    # signEnvelope/verifyEnvelope（对 canonical 头部签名）
│       ├── envelope.ts                # Envelope zod schema、mintEnvelope、parseEnvelope
│       ├── legal.ts                   # 四类别合法信息判定 isLegal()，只看 plaintextHeader
│       └── envelope.test.ts           # 签名/防篡改/canonical/合法性判定用例
│
├── packages/quantum/                  # U2  6 文件
│   ├── package.json                   # deps: @superpose/protocol
│   └── src/
│       ├── index.ts                   # 再导出：QuantumLog/append/seal/open/materialize/interpretableSubset
│       ├── entry.ts                   # QuantumEntry + QuantumRecord zod schema、sealEntry/openEntry
│       ├── log.ts                     # append-only JSONL 哈希链读写、materialize() 折叠为单个点
│       ├── subset.ts                  # interpretableSubset(point, {keyIds,grants,adaptation}) 
│       └── quantum.test.ts            # 哈希链、非法条目拒绝、subset 差异、篡改检出用例
│
├── packages/agent-core/               # U3  8 文件
│   ├── package.json                   # deps: protocol, quantum
│   └── src/
│       ├── index.ts                   # 再导出
│       ├── manifest.ts                # CoreManifest schema、loadManifest/saveManifest（原子写）
│       ├── mount.ts                   # mount 指针 resolve/assert/mount/eject（E_NOT_MOUNTED）
│       ├── session.ts                 # SessionRecord 读写、逐轮追加 history、index.json、恢复最近会话
│       ├── contribute.ts              # 白名单贡献 + 自检与授权双判记录写 contribute.jsonl
│       ├── guard.ts                   # 内部状态动作审计 appendAudit + PIN 比对 [stub] + 失败锁定
│       └── agent-core.test.ts         # manifest 拒绝模型字段、session 稳定性、双判、锁定用例
│
├── packages/mobile-suite/             # U4  8 文件
│   ├── package.json                   # deps: protocol, quantum
│   └── src/
│       ├── index.ts                   # 再导出 + startSuite()
│       ├── device.ts                  # led/display/sensor 模拟设备与动态状态
│       ├── iface.ts                   # 静态接口元数据 + 动态状态快照（三源之第三源）
│       ├── policy.ts                  # policy.json 载入与按 subject/op 的本地策略判定
│       ├── verify.ts                  # 双校验：验签 + 量子权限条目比对 + 本地策略 → DeviceVerdict
│       ├── reqlog.ts                  # requests.jsonl 追加（仅 id/op/verdict，禁上下文正文）
│       └── mobile-suite.test.ts       # 自述权限不通过、过期拒绝、越权 op 拒绝、日志可追溯用例
│
├── packages/embody/                   # U5  8 文件
│   ├── package.json                   # deps: protocol, quantum, agent-core, mobile-suite；bin: superpose-embody
│   └── src/
│       ├── index.ts                   # 再导出 createEmbody
│       ├── main.ts                    # 进程入口：argv/env、装配、退出码 0/1/2
│       ├── converge.ts                # 鉴权 + 三源汇合 + 兼容性核对 → Embodiment
│       ├── loop.ts                    # agent loop、逐轮落盘、decohere() 与 assertCoherent()
│       ├── provider.ts                # Provider 接口 + stub-a/stub-b + 注册表
│       ├── watch.ts                   # mount 指针看门狗（fs.watch + 200ms 轮询兜底）
│       └── embody.test.ts             # 缺源拒绝、验签失败拒绝、退相干后禁止写入用例
│
├── apps/demo/                         # U6  9 文件
│   ├── package.json                   # deps: 全部 workspace 包；scripts: start
│   └── src/
│       ├── index.ts                   # CLI 入口：读 PORT，启动 server
│       ├── server.ts                  # node:http 路由 + /ws WebSocket + 静态文件
│       ├── orchestrator.ts            # insert/eject、spawn/reap Embody、广播状态
│       ├── flow.ts                    # pnpm demo:flow 自动化演示驱动器（HTTP 驱动全流程）
│       ├── public/index.html          # 单页：状态机、消息流、设备面板、插拔按钮
│       ├── public/app.js              # 前端：WS 订阅、渲染、按钮请求
│       ├── public/style.css           # 单页样式（无外部依赖、无 CDN）
│       └── test/flow.test.ts          # 端到端：插入→鉴权→实例化→对话→设备→拔卡→重插
│
├── tests/                             # U7 评审单元：3 测试 + docs/MVP-REVIEW.md = 4 文件
│   ├── eject-residue.test.ts          # 拔卡后 Embody 进程与写入残留判定
│   ├── canary.test.ts                 # canary 不进入全局状态量子与设备日志
│   └── provider-swap.test.ts          # 换 provider 后 sessionId 与历史不变
```

**文件数校验表**

| 单元 | 文件数 | 上限 |
|---|---|---|
| U1 protocol | 9 | 9 |
| U2 quantum | 6 | 9 |
| U3 agent-core | 8 | 9 |
| U4 mobile-suite | 8 | 9 |
| U5 embody | 8 | 9 |
| U6 demo | 9 | 9 |
| U7 review | 4 | 9 |

### 2.1 端口与进程拓扑

| 角色 | 地址 | 进程 |
|---|---|---|
| demo HTTP + WebSocket | `127.0.0.1:7317`，WS 路径 `/ws` | `node apps/demo/src/index.ts` |
| Mobile Suite 请求入口 | `127.0.0.1:7318`，`POST /device-request` | demo 进程内 `startSuite()` 起独立监听 |
| Embody | 无入站端口 | `node packages/embody/src/main.ts --core <coreId>` 独立子进程 |

Mobile Suite 监听独立端口是刻意的：设备请求走真实网络边界，双校验代码路径不得被同进程直调绕过。

---

## 3. 数据结构草案（可直接落为 zod）

以下全部为必填，除显式标注 `optional`。所有 `b64url` 指 RFC 4648 §5 无填充。

### 3.1 `Envelope`（protocol/src/envelope.ts）

```ts
import { z } from "zod";

export const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);   // 32 bytes
export const b64url64 = z.string().regex(/^[A-Za-z0-9_-]{86}$/);   // 64 bytes
export const b64url24 = z.string().regex(/^[A-Za-z0-9_-]{32}$/);   // 24 bytes nonce
export const keyId    = z.string().regex(/^key_[a-z0-9]{8,32}$/);
export const coreId   = z.string().regex(/^core_[0-9a-f]{8,32}$/);
export const suiteId  = z.string().regex(/^suite_[0-9a-f]{8,32}$/);
export const embodyId = z.string().regex(/^embody_[0-9a-f]{8,32}$/);

export const ENVELOPE_TYPES = [
  "iface.metadata",   // Mobile Suite → 量子：静态接口元数据
  "device.state",     // Mobile Suite → 量子：动态设备状态
  "perm.grant",       // 终端 → 量子：权限与操作抽象（授权条目）
  "core.contribute",  // Agent Core → 量子：白名单公开贡献
  "session.head",     // Agent Core → 量子：会话头部指针（不含正文）
  "device.request",   // Embody → Mobile Suite：设备操控请求
  "device.result",    // Mobile Suite → Embody：执行结果
] as const;

export const zEnvelope = z.object({
  id:      z.string().uuid(),                                   // 必填，crypto.randomUUID()
  source:  z.object({
    kind: z.enum(["agent-core", "mobile-suite", "embody"]),      // 必填
    id:   z.union([coreId, suiteId, embodyId]),                  // 必填，须与 kind 前缀一致
  }),
  type:    z.enum(ENVELOPE_TYPES),                              // 必填
  ts:      z.number().int().positive(),                         // 必填，毫秒 epoch
  version: z.literal("0.1"),                                    // 必填，MAJOR.MINOR，MVP 只认 0.1
  corrId:  z.string().uuid(),                                   // 必填；自己发起时 corrId === id
  payload: z.discriminatedUnion("enc", [
    z.object({
      enc:  z.literal("plain"),
      body: z.record(z.unknown()),                              // 必填对象；仍须过 isLegal()
    }),
    z.object({
      enc:  z.literal("aead"),
      body: z.object({
        keyId:      keyId,
        alg:        z.literal("xchacha20poly1305"),
        nonce:      b64url24,
        aad:        z.string().min(8).max(512),                 // 必填，见 3.2
        ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,}$/),   // ≥17 bytes（16 tag + ≥1）
      }),
    }),
  ]),
  sig: b64url64,                                                // 必填，ed25519 对 canonical 头部签名
});
```

**签名范围（写死）**：`canonical({ id, source, type, ts, version, corrId, payload })` —— 即除 `sig` 外全字段。`payload.body` 若为 aead 形态，只签其 `keyId/alg/nonce/aad/ciphertext`（不签明文）。
**canonical JSON**：对象键按 UTF-16 码元升序、无空白、数字用 `JSON.stringify` 默认表示、`undefined` 字段剔除、字符串保留原样不做 Unicode 归一。`sha256(canonicalBytes)` 用于派生子标识与哈希链。
**验签失败**：返回 `E_SIG`，调用方必须**丢弃整条 Envelope**，不得降级为无签名、不得部分消费（SPEC-PR-007）。
**过期**：接收方拒绝 `ts > now + 60_000` 或 `ts < now - 300_000`，返回 `E_STALE`。

### 3.2 `QuantumEntry`（quantum/src/entry.ts）

```ts
export const LEGAL_CATEGORIES = ["env", "perm", "iface", "device"] as const;
export const SENSITIVITY = ["P0", "P1", "P2", "P3", "P4"] as const;

export const zPlaintextHeader = z.object({
  category:    z.enum(LEGAL_CATEGORIES),                 // 必填：合法信息类别
  sensitivity: z.enum(SENSITIVITY),                      // 必填：P0 公开 … P4 禁止导出
  keyIds:      z.array(keyId).min(1).max(8),             // 必填：收件人密钥选择器
  schema:      z.object({
    name:    z.enum(["env.v1", "perm.v1", "iface.v1", "device.v1"]),  // 必填，须与 category 匹配
    version: z.literal("1"),
  }),
  fields:      z.array(z.string().min(1).max(32)).min(1).max(16),      // 必填：结构字段名清单（只报名字）
});

export const zQuantumEntry = z.object({
  keyId:      keyId,                                     // 必填：实际加密所用密钥
  alg:        z.literal("xchacha20poly1305"),            // 必填
  aad:        z.string().min(8).max(512),                // 必填：见下
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,}$/),  // 必填，base64url
  plaintextHeader: zPlaintextHeader,                     // 必填，明文，用于不解密即判定合法性
});

export const zQuantumRecord = z.object({
  seq:      z.number().int().nonnegative(),              // 必填：0 起严格递增
  envelopeId: z.string().uuid(),                         // 必填
  sourceKind: z.enum(["agent-core", "mobile-suite", "embody"]),   // 必填，冗余自 Envelope
  sourceId:   z.string().min(8).max(40),                 // 必填，冗余自 Envelope
  type:       z.enum(ENVELOPE_TYPES),                    // 必填
  ts:         z.number().int().positive(),               // 必填
  version:    z.literal("0.1"),                          // 必填
  corrId:     z.string().uuid(),                         // 必填
  entry:      zQuantumEntry,                             // 必填
  digest:     z.string().regex(/^[0-9a-f]{64}$/),         // 必填：sha256(prevDigest || canonical(记录除 digest))
});
```

**`aad` 定义（写死）**：`aad = base64url(canonical({ id, source, type, ts, version, corrId }))`，即 Envelope 头部。把密文绑定到头部，任何头部篡改都会使解密失败 → `E_DECOMP`。

**`fields` 的必填集合（协议规定，判定时逐项比对）**

| category | schema.name | 必含字段名 |
|---|---|---|
| `env` | `env.v1` | `region`, `epochMs`, `subjects` |
| `perm` | `perm.v1` | `subjectId`, `op`, `resource`, `granteeKeyIds`, `notBefore`, `notAfter` |
| `iface` | `iface.v1` | `deviceId`, `ops`, `meta`, `ownerSuiteId` |
| `device` | `device.v1` | `deviceId`, `state`, `observedAt` |

**合法性判定（protocol/src/legal.ts，返回 `LegalVerdict`）**

```ts
export type LegalVerdict = { ok: true } | { ok: false; code:
  "E_LEGALITY" | "E_CATEGORY_MISMATCH" | "E_FIELDS_MISSING" | "E_KEYIDS_EMPTY" | "E_VERSION" };

isLegal(header: PlaintextHeader, subset: ProtocolSubset): LegalVerdict
```

判定顺序（固定）：① `category ∈ LEGAL_CATEGORIES`；② `schema.name` 与 `category` 前缀匹配且 `version === "1"`；③ `subset.legalFields` 覆盖 `fields` 中出现的每个名字；④ 3.2 表格所列必含字段名全部出现在 `fields`；⑤ `keyIds.length ≥ 1`。任一步失败即非法，**条目不得进入 Valid Space、不得落盘**。

### 3.3 `SessionRecord`（agent-core/src/session.ts）

```ts
export const zMessage = z.object({
  seq:      z.number().int().nonnegative(),                    // 必填，会话内严格递增
  role:     z.enum(["system", "user", "assistant", "tool"]),    // 必填
  text:     z.string().min(0).max(8000),                       // 必填
  ts:       z.number().int().positive(),                       // 必填
  provider: z.object({                                          // optional：产生该条时的 provider 快照
    name:  z.string().min(1).max(32),
    model: z.string().min(1).max(64),
  }).optional(),
});

export const zSessionRecord = z.object({
  sessionId:     z.string().uuid(),      // 必填，首次实例化时铸造，终身不变
  coreId:        coreId,                 // 必填
  createdAt:     z.number().int().positive(),   // 必填
  updatedAt:     z.number().int().positive(),   // 必填
  schemaVersion: z.literal(1),           // 必填
  provider:      z.object({              // 必填，**可变**，且不参与 sessionId 身份
    name:  z.string().min(1).max(32),
    model: z.string().min(1).max(64),
  }),
  turns:         z.number().int().nonnegative(),          // 必填：完成的轮次
  messages:      z.array(zMessage).max(2000),             // 必填，append-only，provider 中立
});
```

**持久化约定（写死）**

- 路径：`data/cores/<coreId>/sessions/<sessionId>.json`，每轮结束整文件原子重写（临时文件 + rename）。
- 追加日志：`data/cores/<coreId>/sessions/<sessionId>.jsonl`，每轮一行 `{seq,role,text,ts,provider?}`，与 `messages` 逐条等价。
- `sessionId` 铸造规则：`crypto.randomUUID()`，仅在 `sessions/index.json.latest` 为空时铸造一次。
- `provider` 字段在每次实例化时被写入当前 provider；**改 provider 不得改 `sessionId`、不得改 `createdAt`、不得改任何既有 `message` 内容**。
- `messages` 只允许 append：实现层必须先校验新数组是旧数组的前缀扩展，否则抛 `E_SESSION_REWRITE`。

### 3.4 `DeviceRequest`（mobile-suite 接收，embody 发起）

```ts
export const DEVICE_OPS = ["device.led.set", "device.display.write", "device.sensor.read"] as const;

export const zDeviceRequest = z.object({
  id:       z.string().uuid(),                         // 必填
  corrId:   z.string().uuid(),                         // 必填，= 发起它的 session.head corrId
  requester: z.object({
    coreId:    coreId,                                 // 必填
    sessionId: z.string().uuid(),                      // 必填
    keyId:     keyId,                                  // 必填，签名密钥
  }),
  target:   z.object({ deviceId: z.enum(["led", "display", "sensor"]) }),  // 必填
  op:       z.enum(DEVICE_OPS),                        // 必填
  args:     z.record(z.unknown()),                     // 必填（可为空对象）
  issuedAt: z.number().int().positive(),               // 必填
  expiresAt:z.number().int().positive(),               // 必填；0 < expiresAt-issuedAt ≤ 30000
  permissionRef: z.string().uuid(),                    // 必填：量子中 perm.grant 的 envelopeId
  sig:      b64url64,                                  // 必填：ed25519 对 canonical(除 sig) 签名
});

export const zDeviceVerdict = z.object({
  requestId: z.string().uuid(),                        // 必填
  ok:        z.boolean(),                              // 必填
  reason:    z.enum([                                  // 必填
    "ok", "E_SIG", "E_STALE", "E_PERM_UNKNOWN",
    "E_PERM_EXPIRED", "E_OP_NOT_GRANTED", "E_POLICY",
  ]),
  checkedAt: z.number().int().positive(),              // 必填
});
```

**双校验顺序（固定，缺一不可通过）**

1. 结构校验（zod）+ `expiresAt` 未过期 → 否则 `E_STALE`。
2. 验签：用 `permissionRef` 之外、由量子 `iface` 条目公布的该 `coreId` 公钥验 `sig` → 否则 `E_SIG`。
3. **权限取自全局状态量子，不取请求方自述**：按 `permissionRef` 在 `materialize()` 的点中查找 `perm.grant` 条目 → 缺失 `E_PERM_UNKNOWN`，已过期 `E_PERM_EXPIRED`，`op` 不在其 `ops` 中 `E_OP_NOT_GRANTED`，`target.deviceId` 不在其 `resource` 中 `E_OP_NOT_GRANTED`。
4. **本地策略比对**：`data/terminal/mobilesuite/policy.json` 的 `allow[<subjectId>]` 必须包含该 `op` → 否则 `E_POLICY`。
5. 全过则执行设备操作并返回 `ok`。无论结果如何，都写一条 `requests.jsonl`。

### 3.5 `CoreManifest`（agent-core/src/manifest.ts）

```ts
export const zCoreManifest = z.object({
  coreId:      coreId,                                  // 必填
  displayName: z.string().min(1).max(48),               // 必填
  createdAt:   z.number().int().positive(),             // 必填
  schemaVersion: z.literal(1),                          // 必填
  protocolSubset: z.object({
    baseline: z.literal("0.1"),                         // 必填
    trimmed:  z.array(z.string().min(1).max(32)).max(16),                 // 必填（可空数组）
    legalFields: z.array(z.enum([                       // 必填，至少覆盖 6 项
      "region", "epochMs", "subjects",
      "subjectId", "op", "resource", "granteeKeyIds", "notBefore", "notAfter",
      "deviceId", "ops", "meta", "ownerSuiteId",
      "state", "observedAt",
    ])).min(6).max(16),                                 // 负载字段名白名单，见 §7 裁决 6
  }),
  identity: z.object({
    did:  z.string().regex(/^did:superpose:[a-z0-9]{8,40}$/),             // 必填
    kind: z.literal("agent"),                           // 必填，仅标签，不参与权限
    owner: z.string().min(1).max(64),                   // 必填，所属，与身份分离
    provenance: z.object({
      issuer:      z.string().min(1).max(64),           // 必填
      issuedAt:    z.number().int().positive(),         // 必填
      derivedFrom: z.string().nullable(),               // 必填（根为 null）
    }),
  }),
  keys: z.object({
    coreSigningPub: b64url32,                           // 必填：ed25519 公钥
    coreBoxPub:     b64url32,                           // 必填：X25519 公钥派生用
  }),
  keyIds:     z.array(keyId).min(1).max(8),             // 必填：本 Core 可解密的目标密钥
  contributes: z.array(z.enum([                         // 必填：允许贡献的字段白名单
    "identity.public", "session.head", "iface.usage",
  ])).max(8),
});
```

**结构禁令（zod `strict()` 强制）**：`CoreManifest` 顶层与 `identity`、`keys` 三层全部 `.strict()`。任何未声明键（尤其 `model`、`weights`、`params`、`systemData`）一律判为非法 manifest，`loadManifest()` 抛 `E_MANIFEST_SHAPE`。禁止存模型参数在此结构层面即被阻断。

---

## 4. 生命周期状态机

### 4.1 状态

| 状态 | 名称 | 可观测判据 |
|---|---|---|
| `S0_EJECTED` | 未插入 | `data/terminal/mount/core.json` 不存在；无 Embody 进程 |
| `S1_AUTH` | 鉴权 | mount 指针存在；Embody 已启动；未完成 PIN 比对 |
| `S2_CONVERGE` | 三源汇合 | 鉴权通过；正在收集三源 |
| `S3_INSTANTIATED` | 实例化 | 三源齐备；agent loop 运行；有 `sessionId` |
| `S4_DECOHERED` | 退相干 | mount 指针消失已超过 0ms；Embody 已退出或正在退出 |
| `S5_RECOVER` | 重插恢复 | mount 指针重新出现；正在读取上次会话 |
| `SX_REJECTED` | 拒绝 | 记录失败原因；不得进入实例化 |

### 4.2 迁移表

| # | 迁移 | 触发条件 | 副作用 | 失败分支 |
|---|---|---|---|---|
| T1 | `S0 → S1` | `mount.mount(coreId)` 成功写入指针文件 | 写入 `data/terminal/mount/core.json`；demo 广播 `lifecycle:S1`；demo spawn `node packages/embody/src/main.ts --core <coreId>`；Embody 写 `data/run/embody.pid` | 指针写入失败（权限/磁盘）→ `S0`，日志 `E_NOT_MOUNTED`；`CoreManifest` 载入失败 → `SX_REJECTED(E_MANIFEST_SHAPE)` |
| T2 | `S1 → S2` | PIN 比对通过（`guard.comparePin` 在 Agent Core 内执行）`[stub]` | 写 `audit.jsonl{action:"auth.ok"}`；广播 `lifecycle:S2` | PIN 错 → 计数 +1，写 `audit{action:"auth.fail"}`，留在 `S1`；连续 3 次 → 锁定 30s，`SX_REJECTED(E_LOCKED)`；`keys/` 缺失 → `SX_REJECTED(E_SOURCE_MISSING:agent-core)` |
| T3 | `S2 → S3` | 三源齐备且互相一致 | 见 4.3；若 `sessions/index.json` 无 latest 则铸造 `sessionId`；把 `provider` 写入 `SessionRecord`；启动 agent loop；广播 `lifecycle:S3` | 缺 Agent Core 源 → `E_SOURCE_MISSING:agent-core`；缺量子源（点为空）→ `E_SOURCE_MISSING:quantum`；缺 Mobile Suite 源（`GET :7318/iface` 不通）→ `E_SOURCE_MISSING:mobile-suite`；`baseline` 不等于 `"0.1"` → `E_VERSION`；量子中任一相关 `Envelope` 验签失败 → `E_SIG`（整条丢弃且不降级）；以上任一 → `SX_REJECTED`，且不产生任何 `session` 写入 |
| T4 | `S3 → S3` | 收到一条用户输入 | 追加 `messages[user]` + 调用 provider + 追加 `messages[assistant]`；`turns += 1`；原子重写 `session.json` 并追加 `session.jsonl`；广播 `turn` | provider 抛错 → 不追加 assistant，`turns` 不变，写 `audit{action:"turn.fail"}`，`S3` 保持不变；`messages` 超过 2000 → `E_SESSION_LIMIT`，拒绝该轮 |
| T5 | `S3 → S3` | agent 决定发起设备请求 | 构造并签 `DeviceRequest` → `POST :7318/device-request`；拿到 `DeviceVerdict`；广播 `request`；结果作为 `messages[tool]` 追加 | `E_SIG` / `E_PERM_*` / `E_POLICY` → 不重试、不降级、不改写权限，直接把 verdict 作为 tool 消息返回给 loop |
| T6 | `S3 → S4` | mount 指针文件消失（看门狗：`fs.watch` + 200ms 轮询兜底） | **即时执行**：① 置 `coherent=false`，此后任何量子写入与设备请求都抛 `E_DECOMP`；② `AbortController.abort()` 中断在途 provider 迭代；③ 停止 loop 调度；④ **不写** Agent Core（此时已不可达，历史已在前几轮落盘）；⑤ 追加 `data/run/decohere.log{at,coreId,sessionId,reason:"mount-vanished"}`（仅 id 与时间，无上下文）；⑥ 250ms 内 `process.exit(0)`；demo 广播 `lifecycle:S4` 并 reap 子进程 | 若 Embody 未在 2000ms 内退出 → demo `SIGKILL`；若退出前仍有量子写入请求 → 被 `assertCoherent()` 抛 `E_DECOMP` 并计入 `decohere.log{lateWrites:n}` |
| T7 | `S4 → S5` | 同一 `coreId` 重新 `mount.mount()` | 读 `sessions/index.json` → 载入 `latest` 的 `SessionRecord`；校验 `messages` 完整性；广播 `lifecycle:S5` | `sessions/` 缺失 → 视为首次实例化，回 `S1`；`SessionRecord` 校验失败 → `SX_REJECTED(E_SESSION_CORRUPT)`，不伪造新会话 |
| T8 | `S5 → S1` | 恢复后进入新一轮鉴权 | 保留 `sessionId` 与 `messages`；仅更新 `provider` 字段为当前配置 | 同 T2 全部分支 |
| T9 | `S1/S2/SX → S0` | `mount.eject()` 或任一拒绝终态 | 删除指针文件；reap 子进程；广播 `lifecycle:S0` | 指针已不存在 → 幂等返回成功 |

### 4.3 三源汇合判据（T3 的唯一实现口径）

| 源 | 采集方式 | 必需性 | 一致性断言 |
|---|---|---|---|
| A  Agent Core | `mount.resolve()` → `manifest.json` + `keys/` + `sessions/index.json` | **必需** | `manifest.coreId === 指针.coreId`；`manifest.protocolSubset.baseline === "0.1"`；`keys.coreSigningPub` 可解 32 字节 |
| B  全局状态量子 | `quantum.materialize()` → 该点的 `perm.grant` / `iface.metadata` / `core.contribute` 条目 | **必需（至少 1 条与本源相关的条目）** | 每条先过 `isLegal`；含本 Core 可达 `keyIds` 的条目 ≥1；`iface.metadata` 中的 `ownerSuiteId` 必须等于 C 的 `suiteId` |
| C  Mobile Suite 设备接口信息 | `GET http://127.0.0.1:7318/iface` → `{ iface, state }` | **必需** | `iface.deviceId` 集合与 `state[].deviceId` 集合相等；`iface.schema.version === "1"` |

**优先级裁决（填补 SPEC 5.1「三源汇合优先级」缺口）**：三源之间**不设优先级**。A 与 C 缺失即硬失败；B 缺失即硬失败。任一源存在但一致性断言失败，也硬失败，不做"用另外两源推断"的降级。C 中的可选设备类别缺失时，仅把 `Embodiment.degraded` 置 `true` 并记录缺失项，不阻塞实例化。

### 4.4 各失败分支的可观测产物

| 失败 | 退出码 | 必写产物 |
|---|---|---|
| `E_SIG` | 2 | `data/run/decohere.log{reason:"sig-invalid",envelopeId}`；无任何数据交换 |
| `E_SOURCE_MISSING` | 2 | 同上 `{reason:"source-missing",source:"agent-core"\|"quantum"\|"mobile-suite"}` |
| `E_BIO` / `E_LOCKED` | 2 | `audit.jsonl{action:"auth.fail",attempts}`（Agent Core 可达时才写） |
| `E_VERSION` | 2 | 同上 `{reason:"incompatible"}` |
| `E_DECOMP` | 1 | `decohere.log{lateWrites}` |

---

## 5. 五条验收测试的判定方法（可命令化）

全部命令在仓库根执行。每条必须能独立复现，不依赖上一条的残留（测试自行清理 `data/`）。

### T1 单测全绿 — `pnpm test`

判定：`vitest run` 退出码 0；输出中每个包至少有 1 个测试文件被执行。

硬性内容判据（缺一即打回）：

| 包 | 必须存在的断言 |
|---|---|
| protocol | 篡改任一头部字段后 `verifyEnvelope` 返回 `E_SIG`；`fields` 缺任必含项 → `E_FIELDS_MISSING`；`category`/`schema.name` 不匹配 → `E_CATEGORY_MISMATCH` |
| quantum | 追加非法条目被拒且文件行数不变；篡改中间行后 `materialize()` 抛 `E_CHAIN_TAMPERED`；两个不同 `keyIds` 的终端得到不同 `interpretableSubset` |
| agent-core | manifest 含 `model` 键被拒 `E_MANIFEST_SHAPE`；`contributes` 白名单外的贡献被拒；`messages` 非前缀扩展时抛 `E_SESSION_REWRITE`；3 次 PIN 错后锁定 |
| mobile-suite | 请求方在 `args` 中自述 `"permission":"all"` 不能通过；`expiresAt` 过期 → `E_STALE`；`op` 越权 → `E_OP_NOT_GRANTED`；`policy.json` 不含该 op → `E_POLICY`；每次请求在 `requests.jsonl` 有且仅有一行 |
| embody | 移除 Mobile Suite 源 → `E_SOURCE_MISSING`；`coherent=false` 后调用量子写入抛 `E_DECOMP` |
| demo | `flow.test.ts` 全流程走通并断言状态序列 `[S1,S2,S3,S3,S4,S5,S3]` |

### T2 一命令起服 + 全流程可演示 — `pnpm demo` / `pnpm demo:flow`

`pnpm demo`：`node apps/demo/src/index.ts` 在 3000ms 内监听 `127.0.0.1:7317`；浏览器打开后页面含元素 `#state`（显示当前状态码）与 `#insert` / `#eject` / `#send` / `#device` 四个控件。

`pnpm demo:flow`：`node apps/demo/src/flow.ts`，纯 HTTP 驱动，必须打印 10 行且退出码 0：

```
[1] insert core_xxxxxxxx -> S1_AUTH
[2] auth ok (pin stub) -> S2_CONVERGE
[3] converge: agent-core=1 quantum=<n> mobile-suite=<m> -> S3_INSTANTIATED
[4] session <uuid> turns=0
[5] turn 1 -> [stub-a] <echo>
[6] device device.led.set verdict=ok
[7] eject -> S4_DECOHERED in <ms>ms
[8] reinsert -> S5_RECOVER session <uuid> (must equal [4])
[9] turn 2 -> [stub-b] <echo>  (provider 已由 flow 切到 stub-b)
[10] RESULT: PASS history=5 messages session=unchanged
```

判定：退出码 0；`[4]` 与 `[8]` 的 `sessionId` 字符串完全相同；总耗时 < 30000ms。

### T3 拔卡后无 Embody 残留 — `pnpm test:accept` 中的 `tests/eject-residue.test.ts`

步骤与判定（全部满足才通过）：

1. 编程启动 demo（`createDemoServer({port: 0})`），`insert`，轮询等 `data/run/embody.pid` 出现且 `process.kill(pid, 0)` 不抛，记 `pid`。
2. 调 `POST /api/core/eject`，记 `t0 = Date.now()`。
3. 每 25ms 轮询 `process.kill(pid, 0)`，要求 2000ms 内开始抛错（进程不存在）。
4. 断言 `data/run/embody.pid` 已删除。
5. 断言 `data/terminal/mount/core.json` 不存在。
6. 记录拔卡时刻前 `quantum.jsonl` 的行数 `L`；等待 500ms 后再次统计，要求仍为 `L`（零新增）。
7. 断言 `data/run/decohere.log` 有且仅有一条 `reason:"mount-vanished"`，且其 `lateWrites` 为 `0`。
8. 断言 `data/cores/<coreId>/sessions/` 下仍存在 ≥1 个 `*.json`（会话信息留存 Agent Core）。
9. 断言 demo 的 `GET /api/state` 返回 `S4_DECOHERED`。

禁止的作弊实现：靠 demo 主动 `child.kill()` 让进程消失。判定方法：第 3 步之前先 `eject` 后立刻 `kill(pid,0)` 探测——实现必须由 Embody 自发退出。测试用注入方式验证：`POST /api/core/eject?noreap=1` 跳过 demo 的 reap，仍要求进程自行消失。

### T4 canary 不进入全局状态量子 — `pnpm test:accept` 中的 `tests/canary.test.ts`

步骤与判定：

1. 在 `data/cores/<coreId>/privatized/p3-private.jsonl` 写入 `{"marker":"CANARY-<uuid4>","note":"do-not-leak"}`，记该字面量为 `CANARY`。
2. 跑完整流程：insert → auth → 3 轮对话 → 2 次设备请求 → 触发一次 `core.contribute` → eject。
3. 递归读取 `data/quantum/` 下**所有** `*.jsonl`，把全部行拼接为字符串；`includes(CANARY) === false`。
4. 同上检查 `data/terminal/mobilesuite/requests.jsonl`，结果同为 false。
5. 反向对照（证明测试有效）：在 `manifest.json` 的白名单字段 `displayName` 中不写 canary，但手工向 `data/quantum/` 追加一条含 canary 的假行，`includes(CANARY) === true` —— 该步骤在临时副本目录执行，结束后删除副本，主目录不受污染。
6. 断言 `data/cores/<coreId>/contribute.jsonl` 每条记录都同时含 `selfCheck: true` 与 `granted: true`（双判记录齐全）。

### T5 换 provider 后 session id 与历史不变 — `pnpm test:accept` 中的 `tests/provider-swap.test.ts`

步骤与判定：

1. `data/config/provider.json` 写 `{"name":"stub-a","model":"stub-1"}`，跑 insert → auth → 3 轮对话。
2. 拍快照 A：`sessionId`、`createdAt`、`turns`（=3）、`canonical(messages[0..2])` 的 sha256。
3. `eject`，断言 `S4_DECOHERED`。
4. 把 `provider.json` 改写为 `{"name":"stub-b","model":"stub-2"}`，`reinsert`。
5. 拍快照 B：`sessionId`、`createdAt`、`turns`、`canonical(messages[0..2])` 的 sha256、`provider.name`。
6. 断言：`B.sessionId === A.sessionId`；`B.createdAt === A.createdAt`；`B.turns === A.turns`；`B.hash === A.hash`（前 3 条消息逐字节未变）；`B.provider.name === "stub-b"`。
7. 再跑 1 轮，断言新 assistant 文本以 `[stub-b]` 开头，且 `turns === 4`，且 `messages.length` 相比快照 B 增加 2。
8. 断言 `sessions/index.json` 的 `all` 长度为 1（换 provider 没有铸造第二个 session）。

### 汇总入口（不属于新增验收项）— `pnpm test:accept`

= `vitest run tests/`。五条验收中 T1 与 T2 由 `pnpm test` / `pnpm demo:flow` 覆盖，T3/T4/T5 由本命令覆盖；评审单元必须在 `docs/MVP-REVIEW.md` 贴出三条命令的原始退出码与关键输出行。

---

## 6. 任务拆分表

7 个单元。U1–U6 可并行开工（U3/U4 只依赖 U1/U2 的**接口签名**，见 6.2 冻结清单）。U7 在 U1–U6 全部完工后开工。

| 单元 | 呼号 | 包 / 目录 | 文件数 | 依赖 | 验收命令 |
|---|---|---|---|---|---|
| U1 | `proto-squad` | `packages/protocol` | 9 | 无 | `pnpm vitest run packages/protocol` + `pnpm typecheck` |
| U2 | `quantum-squad` | `packages/quantum` | 6 | U1 | `pnpm vitest run packages/quantum` |
| U3 | `core-squad` | `packages/agent-core` | 8 | U1, U2 | `pnpm vitest run packages/agent-core` |
| U4 | `suite-squad` | `packages/mobile-suite` | 8 | U1, U2 | `pnpm vitest run packages/mobile-suite` |
| U5 | `embody-squad` | `packages/embody` | 8 | U1, U2, U3, U4 | `pnpm vitest run packages/embody` |
| U6 | `demo-squad` | `apps/demo` | 9 | U1–U5 | `pnpm demo:flow` 打印 `RESULT: PASS` 且退出码 0 |
| U7 | `review-squad` | `tests/` + `docs/MVP-REVIEW.md` | 4 | U1–U6 | `pnpm test:accept` 退出码 0，且五条验收逐条有原始输出 |

### 6.1 每个单元的完成定义（DoD）

- 该单元目录文件数与 2 节表格完全一致，不多不少。
- `pnpm typecheck` 零错误（strict + erasableSyntaxOnly）。
- 该单元自己的 `*.test.ts` 全绿。
- 无任何未完成占位标记（三类禁用占位词在全文零出现，评审单元按此 grep），无空实现，无 `throw new Error("not implemented")`。
- 不越界 import（`pnpm verify:deps` 通过）。
- 术语合规（0.5 节 grep 通过）。

### 6.2 接口冻结清单（U3/U4/U5/U6 开工前必须已由 U1/U2 提交签名，实现体可后补）

```ts
// @superpose/protocol
export function canonical(value: unknown): string;
export function sha256hex(bytes: Uint8Array | string): string;
export function b64urlEncode(bytes: Uint8Array): string;
export function b64urlDecode(text: string): Uint8Array;
export function keyIdOf(pub: Uint8Array): string;
export function signEnvelope(env: Omit<Envelope, "sig">, priv: Uint8Array): Envelope;
export function verifyEnvelope(env: Envelope, pub: Uint8Array): EnvelopeVerdict;
export type EnvelopeVerdict = { ok: true } | { ok: false; code: "E_SIG" | "E_STALE" | "E_VERSION" };
export function mintEnvelope(input: {
  kind: Envelope["source"]["kind"]; sourceId: string; type: Envelope["type"];
  corrId?: string; payload: Envelope["payload"];
}): Omit<Envelope, "sig">;
export function isLegal(header: PlaintextHeader, subset: ProtocolSubset): LegalVerdict;

// @superpose/quantum
export function openLog(dir: string): QuantumLog;
export interface QuantumLog {
  append(env: Envelope, header: PlaintextHeader, keyIds: string[]): Promise<QuantumRecord>;
  materialize(): Promise<QuantumPoint>;
  subset(point: QuantumPoint, q: { keyIds: string[]; grants: string[]; categories?: Category[] }): InterpretableEntry[];
  lastSeq(): number;
}
export async function sealEntry(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<QuantumEntry>;
export async function openEntry(entry: QuantumEntry, key: Uint8Array): Promise<Uint8Array>;
```

U2 的 `QuantumLog` 是 U3/U4/U5 的唯一写入入口。任何单元直接 `fs.appendFile("data/quantum/quantum.jsonl")` 属违规，评审单元按 0.5 + 1.1 双条打回。

### 6.3 打回规则（U7）

任一条不满足即打回对应单元，不整包打回：

| 打回项 | 归属 | 判据 |
|---|---|---|
| 文件数超限 / 多建文件 | 该单元 | 2 节表格比对 |
| 越界 import 或成环 | 引入方 | `pnpm verify:deps` |
| 术语违规 | 该单元 | 0.5 grep |
| 双校验可被自述权限绕过 | U4 | T1 mobile-suite 断言 |
| 拔卡后仍有量子写入 | U5 | T3 步骤 6 |
| sessionId 随 provider 变化 | U3 | T5 步骤 6 |
| canary 出现在量子 | U3 或 U4 | T4 步骤 3/4 |
| demo 靠 kill 而非自发退出 | U5 + U6 | T3 的 `noreap=1` 判定 |

---

## 7. 本契约做出的裁决（供评审追溯）

1. 插卡/拔卡以 `data/terminal/mount/core.json` 指针文件的增删为唯一语义，Agent Core 自身存储在 `data/cores/<coreId>/` 且拔卡后仍存在但不可达。
2. 三源汇合不设优先级：A（Agent Core）与 C（Mobile Suite）缺失即硬失败，B（全局状态量子）缺失亦硬失败；仅 C 的可选设备类别缺失允许 `degraded`。
3. 合法信息判定只看 `plaintextHeader`（含 `fields` 字段名清单），永不解密正文；值级合法性（如 `notAfter > now`）由持有密钥者解密后自行判定。
4. 会话历史在**每轮结束**即落盘 Agent Core，不在拔卡时补写；因此拔卡瞬间的写入失败不影响"会话信息留存 Agent Core"。
5. 无构建步骤：Node 24 原生类型擦除直接执行 `.ts`，`exports` 指向 `src/index.ts`，禁止 `enum`/`namespace`/构造函数参数属性。
6. **`CoreManifest.protocolSubset.legalFields` 的语义裁定为「负载字段名白名单」**（§3.5 已同步）。原稿枚举的是头部元字段名，而 §3.2 第 ③ 步要求 `header.fields ⊆ subset.legalFields` 且第 ④ 步要求 `fields` 含负载字段名，两者按字面组合不可满足（`conformance/README.md` 歧义记录 2 已指出）。裁定后 `legalFields` 取值必须来自 `REQUIRED_FIELDS` 四类的并集，`provisionCore()` 默认写入全部 15 个名字。
7. **量子明文正文的对称密钥与签名私钥在 MVP 内以环境变量注入**（`SUPERPOSE_QUANTUM_KEY` / `SUPERPOSE_CORE_SK` / `SUPERPOSE_SUITE_SK`），契约 0.6「`keys/` 只放公钥，私钥由测试夹具注入」据此落地；生产形态不在 MVP 范围。
8. **Embody 与 demo 之间用 stdio NDJSON 通信**：demo 向 Embody stdin 写命令（`{"cmd":"turn","text":…}`、`{"cmd":"device","device":"led","op":…,"args":{…}}`），Embody 向 stdout 写事件（`{"event":"lifecycle","state":…}`、`{"event":"turn",…}`、`{"event":"request",…}`、`{"event":"rejected","code":…}`）。Embody 仍无入站端口，符合 §2.1。
9. **首个可演示的权限条目与 iface 条目由 Mobile Suite 在插入时发布**（`publishIface()` / `publishGrant()`），令牌结构为 §3.2 的 `iface.v1` 与 `perm.v1`；Embody 只消费不发布权限，符合 §1.2 对 U5 的禁区。
