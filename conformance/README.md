# Conformance（跨实现一致性证据）

本目录只证明一件事：**同一份 `docs/MVP-CONTRACT.md` 契约，被 TS 与 Python 两个彼此独立的实现算出同一结果。**

`vectors.json` 只放**输入**。canonical 字节、sha256、base64url、签名、合法性判定、验签判定全部由两侧各自重算，不存任何期望输出，避免循环论证。

## 文件

| 文件 | 角色 |
|---|---|
| `vectors.json` | 输入用例（23 例）。`ts` 不写死，由运行器按 `runnerNow + tsOffsetMs` 解析 |
| `run-ts.mjs` | 参考侧：调用 `packages/protocol` 的 `canonical/sha256hex/b64urlEncode/signEnvelope/verifyEnvelope/isLegal`，并负责 spawn Python、逐字段比对、给出退出码 |
| `run-python.py` | 独立侧：只用标准库 + 可选 `cryptography` 重新实现 canonical / sha256 / base64url / 合法性 / 验签，不复用 JS |
| `README.md` | 本文件 |

## 运行

```powershell
# 推荐：一条命令，包含两侧比对
node conformance/run-ts.mjs

# 只要结论（不打印 TS 侧 NDJSON）
node conformance/run-ts.mjs --quiet

# 单跑独立侧（调试用；--now 为毫秒 epoch，输出同格式 NDJSON）
python conformance/run-python.py --now 1234567890123
```

`run-ts.mjs` 默认先把 TS 侧结果按 NDJSON 打到 stdout，再打印比对结论；`run-python.py` 只输出 NDJSON。两侧行格式一致，字段见下表。

- 全一致：打印 `CONFORMANCE: PASS (23 cases, ed25519=ok)`，退出码 `0`。
- 任一不一致：打印 `MISMATCH <caseId> <field> ts=<...> py=<...>`，退出码 `1`。
- Python 侧缺少 `cryptography`：`sig`/`verify` 输出 `SKIP`，stderr 说明原因，总判定为 `CONFORMANCE: PASS (23 cases, ed25519=skipped)`。
- `run-ts.mjs` 用相对路径 `../packages/protocol/src/index.ts` 直接导入，因此不依赖 workspace 软链、不需要 `pnpm install`、不修改任何根文件。

## 比对项与判定口径

每个用例两侧输出一行 NDJSON，逐字段比较：

| 字段 | 定义 | 一致性 |
|---|---|---|
| `canonical` | 契约 3.1：`canonical({id, source, type, ts, version, corrId, payload})`，键按 UTF-16 码元升序、无空白、数字用 `JSON.stringify` 表示 | **强一致** |
| `sha256hex` | `sha256(canonicalBytes)` 的小写十六进制 | **强一致** |
| `b64url` | `base64url(canonicalBytes)`，RFC 4648 §5 无填充（即签名输入的原始字节编码） | **强一致** |
| `sig` | 用 `vectors.json` 中公开测试种子对 `canonicalBytes` 的 Ed25519 签名（b64url） | **强一致**（`cryptography` 缺失时 SKIP） |
| `verify` | 契约 3.1 的判定顺序：签名 → `version` → 时效。`{"ok":true}` 或 `{"ok":false,"code":"E_SIG"\|"E_STALE"\|"E_VERSION"}` | **强一致**（缺 `cryptography` 时 SKIP） |
| `legal` | 契约 3.2 的固定五步：category → schema.name → schema.version → fields ⊆ subset.legalFields → 必含字段 → keyIds 非空 | **强一致** |

补充口径：

- **时间锚点**。契约的 `verifyEnvelope` 不接收时钟。`run-ts.mjs` 取一次 `Date.now()` 作为 `--now` 传给 Python，两侧用同一锚点解析 `ts`，因此 `canonical` 逐字节可比；时效判定在 ±（60s 未来 / 300s 过去）窗口上取值远离边界（`-400000`、`+120000`），不会因两侧时钟差几毫秒而漂移。
- **签名只用测试种子**。`vectors.json` 里的 `signer` 是一次性种子，仅供一致性夹具；两侧各自确定性签名后**逐字节比较 `sig`**——`sig` 相等即等价于两侧 canonical 字节相等，同时额外验证 Ed25519 实现的确定性一致。
- **JSON 数字按 double 解析**。契约只规定序列化表示，未规定解析精度；Python 侧用 `parse_int=float` 强制走 IEEE-754 double，与 JS `JSON.parse` 一致（例如 `1234567890123456789` 两侧都四舍五入到同一个 double 再输出）。若实现保留任意精度整数，跨语言必然分叉。
- **字符串转义**。两侧都遵守 `JSON.stringify` 规则：只转义 `"`、`\`、`< 0x20`（其中 `\b \t \n \f \r` 用短式），不转义 `/`、`0x7f`、U+2028/U+2029、非 ASCII；不做 Unicode 归一化（`e` + U+0301 保持两码点）。
- **键序**。TS 默认 `Object.keys().sort()` 是 UTF-16 码元序；Python 侧显式以 `key.encode("utf-16-be")` 排序以对齐（仅用 `sorted()` 会退化为码点序，在非 BMP 键混排时与契约不符）。

## 用例覆盖（23）

| 分组 | 用例 |
|---|---|
| 四类别合法信封 | `valid-env` / `valid-perm` / `valid-iface` / `valid-device` |
| 合法性拒绝 | `missing-required-field`(E_FIELDS_MISSING) / `category-mismatch`(E_CATEGORY_MISMATCH) / `illegal-category`(E_LEGALITY) / `schema-version-mismatch`(E_VERSION) / `empty-keyids`(E_KEYIDS_EMPTY) / `undeclared-field`(E_LEGALITY) / `multi-violation-order`(多违规时按固定顺序取首个) |
| 验签/时效拒绝 | `expired-envelope` / `future-skew`(E_STALE) / `bad-signature`(E_SIG) |
| 序列化边界 | `unicode-escape-boundary` / `key-order-scrambled` / `deep-nested-payload` / `numeric-precision-boundary` / `empty-plain-body` |
| base64url 边界 | `b64url-mod0` / `b64url-mod1` / `b64url-mod2`（canonical 字节长度 mod 3 = 0/1/2） |
| AEAD 载荷 | `aead-payload`（签 `keyId/alg/nonce/aad/ciphertext`，不签明文；`aad` 含 CJK） |

## SKIP 的边界（诚实声明）

| 项 | 什么时候 SKIP | 原因 |
|---|---|---|
| `sig` / `verify` | Python 环境无法 `import cryptography` | 零原生依赖的约束下，Python 标准库没有 Ed25519；不引入 `node-gyp` 类依赖是硬约束，故降级为 SKIP 并在 stderr 显式说明，绝不伪造成 `ok` |

`canonical` / `sha256hex` / `b64url` / `legal` 四项**永远强一致**，不受 SKIP 影响。

## 契约歧义记录（发现即写这里，不改用例掩盖）

1. **3.2 判定顺序第 ② 步把 `schema.name` 与 `version` 合并描述，未给出版本失败的错误码。** `LegalVerdict` 联合里存在 `E_VERSION`，现实现（`packages/protocol/src/legal.ts`）把 name 失败判 `E_CATEGORY_MISMATCH`、version 失败判 `E_VERSION`。本套件以 `schema-version-mismatch` 用例把该读法钉死为 `E_VERSION`。另：第 ⑤ 步的 `E_KEYIDS_EMPTY` 在 `parseEnvelope` 之后不可达（zod 已 `min(1)`），但 `isLegal()` 对未解析输入可达，`empty-keyids` 用例钉的是后者的行为。
2. **3.5 `CoreManifest.protocolSubset.legalFields` 的枚举与 3.2 的 `fields` 语义冲突。** 3.5 枚举只含头部元字段名（`category`、`sensitivity`、`keyIds`、`schema`、`fields`、`sourceKind`、`type`、`ts`、`version`），而 3.2 的必含字段表要求 `fields` 含负载字段名（`region`、`epochMs`、`subjects` …），第 ③ 步又要求 `fields ⊆ subset.legalFields`。按字面理解，任何 CoreManifest 都无法让一条合法条目通过 ③。本套件采用 `packages/protocol` 既有测试的读法：`subset.legalFields` = 允许出现的**负载字段名**集合。**已由 `docs/MVP-CONTRACT.md` §7 裁决 6 采纳并同步 §3.5（枚举改为 15 个负载字段名，min 6 / max 16）。**
3. （已解决的口径缺口，非未决冲突）契约只规定"数字用 `JSON.stringify` 默认表示"，未规定 JSON **解析**精度。JS `JSON.parse` 一律转 double，Python `json` 保留任意精度整数；本套件强制 Python 也走 double。跨语言实现应遵守同一约定，否则大整数会分叉。

新增用例时：只追加**输入**，两侧重新计算；若两侧不一致并且可判定为契约未规定，按上面的格式追加一条记录并上报，**不得**反向修改用例或某一侧输出去凑一致。

## 术语纪律

本目录遵守 `docs/MVP-CONTRACT.md` 0.5：Agent Core / Embody / Mobile Suite / 全局状态量子 / Valid Space / 信息空间。不出现被禁同义词。
