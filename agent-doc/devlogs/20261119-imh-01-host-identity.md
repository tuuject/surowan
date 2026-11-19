# Surowan - 20261119 IMH-01：Topic id 不再丢精度，存储里的 host_kind 严格解析

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 的第一个工作包 IMH-01，解决计划「残留的单 Host 假设」里的 A1、A2 两条：

- **A1**：`ImConversationRef.topicId` 是 `number | null`。从库里读出的 bigint `message_thread_id` 在 `identityConversation`、`runtime/support.ts` 的会话解析和 `capabilities/send/deliver.ts` 的发送目标里都要先 `Number(...)` 一遍。Telegram 的 topic id 远小于 2^53，所以今天不出错；以后接 Discord 这类 64 位 snowflake 的 Host，两个只差低位的 id 会被舍入成同一个数，`conversationKey` 相撞，限流窗口和 typing 轮次就会串台。
- **A2**：读 `chats.host_kind` 的地方用 `=== 'playground' ? 'playground' : 'telegram'`（或者反过来）的三元式，或者直接 `as HostKind`。库里一旦出现第三种取值，就会被当成 Telegram（或 Playground）去调度、发送、记账。`long-tasks` 里会话行不存在时也会落到 `'telegram'`。

本包不动数据库，不改模型可见的任何东西。`test/im/pinned-surface.test.ts` 的期望值没有改。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-01: bigint topic ids and strict host_kind parsing」）实现，共一轮首次实现加一轮修正。主会话负责 review、复验与交付。

## 主要变更

### 1. Topic id 全程 bigint，只在 Telegram wire 上转 number

- `ImConversationRef.topicId` 改为 `bigint | null`（`src/platform/im-host/identity.ts:83`）。`identityConversation`、`runtime/support.ts` 的 `resolveConversation`、`send/deliver.ts` 的 `prepareSend` 都直接传 bigint。`conversationKey` 用模板字符串、`sameConversation` 用 `===`，对 bigint 都是精确的。
- 转 number 的地方只剩一处：`wireThreadId`（`src/adapters/local-monolith/telegram/grammy-transport.ts:27`）。超出安全整数范围时抛 `UnsafeTopicIdError`，不发往一个舍入后的 topic。发送和 typing 都经过它。
- `telegram/host.ts` 捕获 `UnsafeTopicIdError`，返回永久失败 `telegram_topic_id_unsafe`（`src/adapters/local-monolith/telegram/host.ts:308`），发送行与 Tool Call 都按失败落盘。
- `host.ts` 加上这些改动后超过了 20 KB 的提交上限，所以把 grammY transport 适配（`grammyTelegramTransport`）连同 wire 转换一起拆到新文件 `grammy-transport.ts`；`instance.ts`、`doctor.ts` 和两个测试的 import 跟着改了。

### 2. `parseHostKind` / `isHostKind`

```ts
export function isHostKind(value: unknown): value is HostKind {
  return (HOST_KINDS as readonly unknown[]).includes(value);
}

export function parseHostKind(value: unknown): HostKind {
  if (isHostKind(value)) {
    return value;
  }
  throw new Error(`Unknown host kind: ${String(value)}`);
}
```

（`src/platform/im-host/identity.ts:7`、`:21`）

单次操作的调用点一律用 `parseHostKind`，未知值直接失败：`runtime/support.ts` 的会话解析、`long-tasks` 的插件 Host 校验、`ContextBuilder.identity`、`deliveryBlockReason`、`prepareRowImage`、`readOriginalFile`。

批量循环不能让一行脏数据拖住其余的行，所以用「本构建不服务这个 Host」的语义：

- `conversationsOfHosts`（`src/orchestration/host-scope.ts:36`）去掉了「所有 Host 都就绪时返回 `1 = 1`」的捷径，始终生成 `host_kind IN (<服务中的 Host>)`。调度器、回执投递和恢复都靠它选行，未知 Host 的行不会被选中，原样留给认识它的构建处理。
- `generationEligibilityForHosts`（`src/image/host-eligibility.ts:37`）对未知 Host 返回 `false`。生图 worker 启动恢复和 `bridge.reconcile()` 都用这个判断，所以一条脏数据不会再让图片服务、连带整个 Bot 起不来。
- 模型切换的 `agentModelKey`（`src/orchestration/model-switch.ts:45`）遇到未知 Host 跳过该行。

今天 `chats` 表的 CHECK 约束还在枚举 Host，所以这类行实际写不进去。IMH-02 会按计划去掉这个 CHECK，那之后才有现实来源（例如更新的构建写入的行），本包提前把读侧收紧。

### 3. 去掉隐式默认

- `long-tasks` 的 `#assertPluginHost`（`src/store/long-tasks/index.ts:168`）：会话行不存在时显式报错，不再当成 Telegram。原来按会话 id 缓存 Host 的进程级 Map 删掉了：`conversations.id` 没有 AUTOINCREMENT，删 Chat 后 id 可能被新的 Playground 会话复用，缓存会让 Telegram 专属插件通过校验。现在每次创建 scope 都查一次带索引的行。
- `RowImageSource`（`src/capabilities/media/image-input.ts:20`）改为联合类型：只有 Memo blob（`localFile`）可以不带 `hostKind`，其余来源必须带。Sticker 索引合成的行显式写 `hostKind: 'telegram'`（`src/capabilities/media/sticker-index.ts:50`），`undefined → telegram` 的映射删除。
- `InvocationContext.hostKind` 等三处字面量联合改为引用 `HostKind`。`invocation-context.ts` 原本自述是不 import 任何 src 模块的叶子，现在允许唯一一个 type-only 的 `HostKind` 导入，头注释同步更新。`previewContext` 的默认参数留给 IMH-03 处理。

### 4. 测试

- `test/im/contract.test.ts`：2^53+1 的 topic id 经 ref 构造和 `conversationKey` 后值不变；两个只差低位的大 id 得到不同的 key。
- `test/im/lossless-topics.test.ts`：存储会话解析保留超大 topic；`prepareSend` 的目标与 `host_sends` 行保持原值；`42n` 在 Telegram 请求里仍是数字 `42`；不安全的 topic 被拒绝，`host_sends` / `tool_calls` 落 `error` / `telegram_topic_id_unsafe`。
- `test/im/strict-host-kind.test.ts`：用 `ignore_check_constraints` 写入未知 `host_kind`，覆盖上面每个调用点。单次操作的路径要抛错。调度器回执用真实的 `processTasksDue` 驱动：同一轮里有效回执被认领，未知 Host 的回执保持 pending、没有 cancel reason，整个过程不抛错。生图只测了资格谓词（未知行 `false`、有效行 `true`），没有驱动 worker 启动。另有 id 复用的回归：Telegram 会话删除后，同 id 插入 Playground 会话，Telegram 专属插件被拒绝。
- `test/tasks/long-tasks.test.ts` 里用虚构会话 `999n` 测跨会话隔离的一行，改为插入真实的第二个会话，因为严格校验之后虚构的会话 id 会直接报错；测试意图不变。

子 agent 报告：首轮新测试在旧代码上 14 个失败，修正轮新增的 4 个回归测试在修复前失败，修复后全部通过。

## Review

首轮实现后用 ocr 审了一轮（16 个文件，11 条意见），主会话逐条核实：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| 一行未知 Host 让调度器回执整批回滚、生图 worker 启动失败（3 条合并） | 成立（前提要等 IMH-02 去掉 CHECK 才可达） | 打回：SQL 始终按服务中的 Host 过滤，生图资格对未知 Host 返回 false |
| `RowImageSource.hostKind` 可选，缺省走 Telegram 下载器 | 成立 | 打回：除 Memo blob 外必填 |
| `long-tasks` Host 缓存在 id 复用后过期 | 成立（原有问题） | 打回：删缓存 |
| `UnsafeTopicIdError` 文案在 2^53 处不准；测试夹具 `INSERT OR IGNORE` 吞错 | 成立 | 打回：小修 |
| mention-typing 回退查询只看 Telegram 行 | 误报 | 调用方是持有 Telegram chat id 的 Telegram adapter |
| 模型切换的 chat 范围判断漏掉未知 Host 行 | 误报 | 其他 Host 的 Invocation 本来就不属于某个 Telegram chat |
| 不安全 topic 在被拒前已占用发送屏障 | 不改 | wire 守卫是最后一道断言，计账方式与 `MissingTransportCapability` 等确定性拒绝一致 |
| 不安全 topic 的 typing 轮次空转 | low，丢弃 | — |

修正轮没有再跑 AI review，由主会话逐条对照并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts
# 全部通过
pnpm test test/im test/send test/tasks test/typing.test.ts test/image test/media   # 首轮，连跑 3 次
# 每次 60 files / 236 tests passed
pnpm test   # 修正轮之后，完整层
# Test Files 427 passed | 1 skipped (428); Tests 2123 passed | 9 skipped (2132); 794.68s
```

base（`1fb681d8`）上的基线全量：425 passed | 1 skipped，没有已知失败。

rebase 到 `cc92708d`（上游新增的 MCP servers 面板提交，与本包没有文件重叠）后，重跑了 `pnpm run lint`、`pnpm run check` 与 `pnpm test test/im test/send test/tasks test/scheduler test/image test/media test/mcp test/typing.test.ts test/schema/index-plans.test.ts`。

未执行：`pnpm run admin:test:e2e`（本包没有改 Admin API 或其查询）；真实 Telegram 验收（Forum Topic 收发与 typing），由用户执行。

## 提交

```txt
fd6a7b4e Keep topic ids lossless and parse host kinds strictly
```
