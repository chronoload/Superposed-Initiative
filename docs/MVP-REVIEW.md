# Superpose MVP 评审报告（U7）

评审对象：`mvp` 分支 worktree（`Superpose-mvp`），契约 `docs/MVP-CONTRACT.md` v1.0。
评审日期：2026-10-24。
环境：Windows / Node 24 / pnpm 10.30.3 / vitest 5.0.5。

## 1. 命令与原始结果

### 1.1 `pnpm typecheck`

```
> tsc --noEmit
（无输出）
EXIT=0
```

### 1.2 `pnpm test`（T1）

```
 RUN  v5.0.5

 ✓ packages/protocol/src/envelope.test.ts (30 tests)
 ✓ packages/quantum/src/quantum.test.ts (9 tests)
 ✓ tests/eject-residue.test.ts (1 test)
 ✓ tests/canary.test.ts (1 test)
 ✓ tests/provider-swap.test.ts (1 test)
 ✓ packages/agent-core/src/agent-core.test.ts (17 tests)
 ✓ apps/demo/test/flow.test.ts (1 test)
 ✓ packages/mobile-suite/src/mobile-suite.test.ts (10 tests)
 ✓ packages/embody/src/embody.test.ts (8 tests)

 Test Files  9 passed (9)
      Tests  78 passed (78)
EXIT=0
```

每个 workspace 包都至少执行了一个测试文件；`tests/` 三条验收也在本命令中执行。

### 1.3 `pnpm demo:flow`（T2）

```
[1] insert core_89a0d4fa4e9f63cb -> S1_AUTH
[2] auth ok (pin stub) -> S2_CONVERGE
[3] converge: agent-core=1 quantum=7 mobile-suite=3 -> S3_INSTANTIATED
[4] session 5963dc68-99ee-4d76-8d2b-4e9da65a8fd3 turns=0
[5] turn 1 -> [stub-a] 你好
[6] device device.led.set verdict=ok
[7] eject -> S4_DECOHERED in 3ms
[8] reinsert core_89a0d4fa4e9f63cb -> S5_RECOVER session 5963dc68-99ee-4d76-8d2b-4e9da65a8fd3 turns=1
[9] turn 2 -> [stub-b] 第二轮
[10] RESULT: PASS history=5 messages session=unchanged
EXIT=0
```

`[4]` 与 `[8]` 的 `sessionId` 完全相同。`flow.ts` 已改为每次运行创建独立临时 `dataDir` 并在退出前删除，因此重复执行不依赖也不污染仓库内 `data/`。

`pnpm demo` 冒烟：`node apps/demo/src/index.ts` 启动后 1500ms 内 `GET /` 返回 `HTTP=200`，页面包含 `#state`、`#insert`、`#eject`、`#send`、`#device` 五个元素；`GET /api/state` 返回 `S0_EJECTED`。

页面另含「机制证据」栏：三源收敛（A manifest / B 量子 / C iface）、量子哈希链最近 10 条、设备请求四步校验、退相干记录与落盘路径。浏览器实测：插入后三源点亮、每轮对话量子条目 +1、`device.led.set` 四步全 pass、弹出后 `reason mount-vanished` 出现、重插后三源再次收敛；无 JS 运行时错误，`/ws` 正常。

### 1.4 `pnpm test:accept`（T3/T4/T5）

```
 RUN  v5.0.5

 ✓ tests/eject-residue.test.ts (1 test) 1253ms
   ✓ T3 拔卡后无 Embody 残留
     ✓ Embody 自发退出，量子零新增，会话留存 1051ms
 ✓ tests/canary.test.ts (1 test) 1365ms
   ✓ T4 canary 不进入全局状态量子
     ✓ 三轮对话与两次设备请求后，量子与请求日志均无 canary 709ms
 ✓ tests/provider-swap.test.ts (1 test) 1414ms
   ✓ T5 换 provider 后 session id 与历史不变
     ✓ 身份与会话在刚体更替后保持，前缀切换到 stub-b 1203ms

 Test Files  3 passed (3)
      Tests  3 passed (3)
EXIT=0
```

### 1.5 辅助门禁

```
pnpm verify:deps
verify:deps OK (6 packages)
EXIT=0
```

6 个包 = protocol / quantum / agent-core / mobile-suite / embody / demo；依赖方向与无环检查全部通过。

```
node conformance/run-ts.mjs
CONFORMANCE: PASS (23 cases, ed25519=ok)
EXIT=0
```

## 2. 五条验收逐条结论

| # | 验收 | 判定 | 关键证据 |
|---|---|---|---|
| T1 | 单测全绿 | **通过** | 9 文件 / 78 用例全过；protocol 30、quantum 9、agent-core 17、mobile-suite 10、embody 8、demo 1，`tests/` 3 |
| T2 | 一命令起服 + 全流程 | **通过** | `pnpm demo:flow` 打印 10 行、退出码 0、`RESULT: PASS`、`[4]=[8]`；`pnpm demo` 页面 5 个必需元素齐全 |
| T3 | 拔卡后无 Embody 残留 | **通过** | `noreap=1` 下 Embody 自发退出（实测 < 2000ms）；pid/mount 删除；量子 500ms 内零新增；`decohere.log` 恰一条 `mount-vanished` 且 `lateWrites:0`；sessions 留存；state=S4 |
| T4 | canary 不进入全局状态量子 | **通过** | 3 轮对话 + 2 次设备 + eject 后，量子与 `requests.jsonl` 均无 CANARY；临时副本反向对照能检出 CANARY；`contribute.jsonl` 每条均 `selfCheck:true, granted:true` |
| T5 | 换 provider 后身份与历史不变 | **通过** | `sessionId`/`createdAt`/`turns`/前 3 条消息哈希均不变；`provider.name` 变 `stub-b`；下一轮前缀 `[stub-b]`、`turns=4`、messages +2；`sessions/index.json.all` 长度 1 |

文件数校验（与 §2 表一致，无多建文件）：

| 单元 | 实测 | 上限 |
|---|---|---|
| U1 protocol | 9 | 9 |
| U2 quantum | 6 | 9 |
| U3 agent-core | 8 | 9 |
| U4 mobile-suite | 8 | 9 |
| U5 embody | 8 | 9 |
| U6 demo | 9 | 9 |
| U7 review | 4 | 9 |

术语 grep（`docs/ packages/ apps/ tests/` 范围）：`Harness` / `Carrier` / `环境投影` / `状态写入空间` 仅出现在 `docs/MVP-CONTRACT.md` 的「禁止写」列，属允许位置；未发现违规指代。
占位 grep：无 `TODO` / `FIXME` / `throw new Error("not implemented")`；`[stub]` 仅出现在 PIN 与 `coreBoxPub` 派生处，均按 §0.2 标注。

## 3. 实现裁决记录（契约未覆盖或需落地的细节）

1. **恢复期生命周期广播**：契约 T7/T8 描述 `S4→S5→S1` 后再实例化。实测若恢复时广播 `S1/S2`，T2 的状态序列会多出两项，无法满足 §5 T1 对 `[S1,S2,S3,S3,S4,S5,S3]` 的硬性断言。实现裁决：重插时 `latestSession` 已存在则只广播 `S5_RECOVER`，随后回到 `S3_INSTANTIATED`；PIN 与三源在恢复路径仍全部重新校验。该裁决不改变「恢复同一 sessionId 与历史」的可观测语义。
2. **provider 热切换**：Embody 每轮重新读取 `data/config/provider.json`，未重启进程、未引入额外生命周期事件，避免破坏 T2 序列。
3. **`provisionCore` 与 `sessions/index.json`**：`provisionCore()` 会初始化空的会话索引。demo 改为仅在 manifest 缺失时 provision，保证 eject/reinsert 不重置会话。
4. **demo 的 stdio 协议**：按 §7 裁决 8 落地；Embody 无入站端口，demo 以 stdin NDJSON 下发 `turn` / `device`，以 stdout 接收 `lifecycle` / `turn` / `request` / `rejected` / `degraded`。
5. **iface / perm.grant 发布者**：按 §7 裁决 9，由 Mobile Suite 在插入时经 `publishIface()` / `publishGrant()` 写入量子；Embody 只消费权限。
6. **`legalFields` 语义**：按 §7 裁决 6，`provisionCore()` 写入 15 个负载字段名并集；`isLegal()` 以 `header.fields ⊆ legalFields` + 必含字段名清单双重判定。
7. **密钥注入**：按 §7 裁决 7，`SUPERPOSE_QUANTUM_KEY` / `SUPERPOSE_CORE_SK` / `SUPERPOSE_SUITE_SK` 经环境变量注入，`keys/` 仅存公钥。
8. **`coreBoxPub`**：MVP 不引入 X25519，以签名公钥的 sha256 摘要充当派生值，代码标注 `[stub]`。

## 4. 契约缺口（不阻塞 MVP，但需在下一版契约修正）

1. **量子记录不含 Envelope 签名**：§3.2 的 `QuantumRecord` 没有 `sig` 字段，而 §4.3/T3 要求「量子中任一相关 Envelope 验签失败 → `E_SIG`」。实现只能验证：条目可解、密钥可达、`aad` 绑定、哈希链摘要一致；无法对量子条目复现 Envelope 级 ed25519 验签。当前 `converge` 的 `E_SIG` 覆盖「公钥不可解」与「条目不可解密」。建议下一版在 `QuantumRecord` 增加 `sig` 与 `sourcePub`，或把 §4.3 的表述改为「量子条目哈希链与解密完整性」。
2. **`sealEntry` 签名与 `plaintextHeader` 的错位**：§6.2 冻结的 `sealEntry(plaintext, key, aad)` 不含 `plaintextHeader`，实现以占位头部返回、由 `log.append()` 以调用方 header 覆盖。条目不会带着占位头部落盘，但接口签名与数据结构存在耦合缺口；建议下一版让 `sealEntry` 显式接收 header。
3. **`endpoint` 端口固定为 7317/7318**：契约 §2.1 固定端口，验收测试使用 `port: 0` 注入随机端口。实现已支持注入；文档未写明测试可使用临时端口，建议补一句。
4. **`demo:flow` 的 `dataDir`**：契约未规定 `flow.ts` 必须使用临时目录。实现已改为临时目录 + 退出清理，以保证重复执行幂等（首次实现使用默认 `data/`，第二次运行会因历史累积而失败，已修正）。

## 5. 打回清单

无。U1–U6 均满足文件数、typecheck、单测、依赖方向、术语与占位词门禁；三条验收测试全部通过。

## 6. 主工作目录隔离确认

全部实现、测试与文档改动仅发生在 worktree `Superpose-mvp`（分支 `mvp`）。主目录 `Superpose` 未执行任何写操作，其工作树状态保持接手前原状。
