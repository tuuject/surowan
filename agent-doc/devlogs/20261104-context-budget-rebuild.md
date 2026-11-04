# Surowan - 20261104 Context Window 热更新与 `/rebuild_context`

## 背景

生产环境把 `deepseek/deepseek-v4-flash-0731` 的 `context_window` 从 `1048576` 调低到 `262144`，希望缓解长上下文下的工具调用异常。配置热更新后，Harness 仍沿用按旧窗口构建的连续 Context，模型继续收到不再符合新预算的 transcript；当时只能 `/cut_topic` 清掉 Context，但该命令会同时截断聊天历史。

根因有两处：

- `ConversationContextStore.open()` 只比较 `system_prompt_hash`。模型 `context_window` / `max_tokens` 变化没有参与失效判断。
- `ConversationRuntime` 的缓存 Agent 也只按 `system_prompt_hash` 复用，即使 Context 需要重建，也可能继续用旧 transcript。

另外，`/cut_topic` 的 abort 只发信号、不等运行落定，旧 Invocation 在信号生效前排好的 `message_end` 或 GC 仍可能写进刚清空的 Context。新命令需要比这更强的写栅栏。

## 决策

**预算指纹存进 Context，而不是把窗口塞进 prompt hash。** 窗口只影响预算，不应改变 prompt 身份；把 `context_window` / `max_output_tokens` 存成独立列，下次运行比较预算，只有保留 transcript 真的超过新预算才重建。窗口变大或 transcript 仍放得下时保留连续性，只更新记录值。

**重建只丢 canonical transcript，不碰聊天记录。** 消息、Revision、`conversation_context_cutoffs`、Memo Pad 与群聊记忆都不动；下一次 Invocation 按当前 `history_messages` 与 Context Window 规则重新渲染最近的 history。

**用 `generation` 做写栅栏，不依赖 abort 时序。** 每次 canonical 重置递增 `generation`；`append` / `advanceHead` / `clear` 在事务内核对 header 的 generation，过期写入抛 `StaleContextError`，`touch` 静默跳过。这样 `/rebuild_context` 可以先 abort、立刻重建并返回，不需要等旧运行完全落定。

**`/rebuild_context` 复用 `rebuildForConversations`，不写切点。** 它和 `/cut_topic` 一样是 Conversation 级、管理员命令；区别是只重置连续 Context，历史边界保持原样。

**拆 `context/store.ts`。** pre-commit 限制单文件 20 KB，拆分后按职责放进 `src/context/store/{index,types,queries}.ts`，所有 importer 指向具体模块，不留 re-export shim。

## 主要变更

### 1. 迁移 052

`src/store/migrations/052_context_rebuild.sql`：

```sql
ALTER TABLE conversation_contexts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversation_contexts ADD COLUMN context_window INTEGER;
ALTER TABLE conversation_contexts ADD COLUMN max_output_tokens INTEGER;
```

`generation` 默认 1；两个预算列可空，升级前的旧行在首次打开时只采纳当前预算，除非保留 transcript 已经超预算。schema 同步在 `src/store/schema/invocation.ts:149`。

### 2. `open()` 按预算失效

`src/context/store/index.ts:44` 的 `open` 新增 `options.budget`，返回 `reason`：

```ts
if (storedWindow === null || storedMaxOutput === null) {
  // A Context written before 052 has no recorded budget. Adopt the current
  // one without discarding continuity, unless the retained transcript
  // already exceeds it (for example a window lowered before the upgrade).
  if (this.stats(existing).retainedTokens > budget.maxRetainedTokens) {
    this.#reset(existing, timestamp, { budget });
    return { header: this.#requireHeader(conversationId), rebuilt: true, reason: 'context_window' };
  }
  // ... adopt
}
if (storedWindow === BigInt(budget.contextWindow) && storedMaxOutput === BigInt(budget.maxOutputTokens)) {
  return { header: existing, rebuilt: false, reason: null };
}
if (this.stats(existing).retainedTokens > budget.maxRetainedTokens) {
  this.#reset(existing, timestamp, { budget });
  return { header: this.#requireHeader(conversationId), rebuilt: true, reason: 'context_window' };
}
```

`#reset` 删除 `context_messages` / `context_refs`、复位 `head_seq`/`next_seq`/`send_count_total`、清空 `active_invocation_id`、递增 `generation`。`ContextBudget` 与 `StaleContextError` 在 `src/context/store/types.ts:42`。

### 3. 运行侧计算保留预算

`src/orchestration/agent-runtime/run.ts:86`：

```ts
const promptTokens = Math.ceil(stable.systemPrompt.length / 4);
const toolReserveTokens = Math.ceil(model.contextWindow * 0.1);
const maxRetainedTokens = Math.max(
  0,
  Math.floor(model.contextWindow * config.agent.context_stop_ratio) -
    model.maxTokens -
    promptTokens -
    toolReserveTokens,
);
```

Tool 预留取 `validateToolRegistry` 的 10% 上限。`context_rebuilt` 日志新增 `reason`（`system_prompt` / `context_window`）。缓存 Agent 复用同时核对 `entry.header.generation`（`src/orchestration/agent-runtime/run-agent.ts:154`）。

### 4. `generation` 写栅栏

`src/context/store/index.ts:429`：

```ts
#assertGeneration(header: ContextHeader): void {
  const current = this.#store.orm
    .select({ generation: conversationContexts.generation })
    .from(conversationContexts)
    .where(eq(conversationContexts.id, header.id))
    .get();
  if (current === undefined || current.generation !== header.generation) {
    throw new StaleContextError(header.id);
  }
}
```

`append`、`advanceHead`、`clear` 都在事务内调用它；`clear` 和 `rebuildForConversations` 递增 generation；`touch` 带 generation 条件，旧运行收尾不会改新 Context 的 `active_invocation_id`。

### 5. `/rebuild_context`

`src/orchestration/bot-commands/session.ts:140`：

```ts
deps.scheduler.abortConversation(conversationId, 'context_rebuild');
const rebuilt = deps.contexts.rebuildForConversations([conversationId], now);
deps.conversationRuntime?.forget(conversationId);
```

命令注册在 `src/orchestration/bot-commands/index.ts:119`，管理员 gate 与 `/cut_topic` 一致；不写 `conversation_context_cutoffs`，重复执行安全，没有 Conversation 或 Context 时直接回复无需重建。`BucketScheduler.abortConversation` 新增可选 reason，`/cut_topic` 仍用默认 `context_cut`。

### 6. 模块拆分

- `src/context/store/index.ts`：`ConversationContextStore`。
- `src/context/store/types.ts`：`ContextHeader`、`ContextBudget`、`StaleContextError`、窗口行与统计类型。
- `src/context/store/queries.ts`：`listConversationContexts`、`runningInvocationForConversation`。

所有 importer 已按符号改到具体模块；`src/context/gc.ts` 只保留原有的 `ContextWindowRow` 公开 re-export。

## 测试与文档

- `test/context/store-conversation.test.ts`：预算缩小且超预算时重建、放得下时保留、pre-052 空预算行采纳/超预算重建、generation 拒绝旧 header 的 `append`/`advanceHead`/`clear`。
- `test/cut/rebuild-context.test.ts`：丢弃 Context 但保留聊天历史与切点、Topic 隔离、中止运行中 Invocation（`context_rebuild`）并拒绝迟到写入、非管理员拒绝、重复执行、无 Context 无副作用、Memo Pad 保留。
- `test/config/context-window-reload.test.ts`：真实 reload 把 `context_window` 从 1M 降到 262k，下一次 Invocation 重建超预算 Context，模型 prompt 不再包含旧 transcript，最近聊天记录仍可见。
- 迁移版本断言升到 52：`foundation.test.ts`、`scene/retention.test.ts`、`schema/migrations-mcp-images.test.ts`、`tasks/migration-upgrades.test.ts`。
- 文档：`agent-doc/telegram-agent-flow.md`（命令、预算重建、generation 栅栏）、`configuration.md`（热更新行为）、`data-layer.md`（052 列）、`verification.md`（测试矩阵与手工验收）、用户指南与产品知识索引。

## 验证

```bash
pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm run lint
# biome lint + format 通过（1245 / 1242 个文件）

pnpm exec vitest run test/context/store-conversation.test.ts test/cut/rebuild-context.test.ts test/config/context-window-reload.test.ts test/context/gc.test.ts test/context/hot-inject-continuity-windowing.test.ts test/memo/injection.test.ts test/bot-commands test/runtime/host.test.ts
# 15 files；99 passed

pnpm run docs:build && pnpm run docs:verify
# Verified 48 HTML/Markdown pages, search, examples, schema, provenance and 158 HTTP resources (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 48 HTML/Markdown pages, ... 158 HTTP resources (base /surowan/)

git diff --check
# 无输出
```

全量 `pnpm test` 在本机跑了两次，各有一个与本改动无关的时序 flake：

- 第一次：`test/playground/only-serve.test.ts` 的 5s 进程启动超时；该文件用 `--testTimeout=30000` 全过。
- 第二次（拆分后）：`test/cli/panel/auth.test.ts` 的 `--session` 参数解析 flake；单独复跑 7 passed。

其余 369 个文件、2053 个用例通过，1 个文件跳过。未执行真实 Telegram 群里的 `/rebuild_context` 与真实 Provider 下的长上下文验收（需要生产配置与真人账号）。

## 已知限制

- Tool 预留固定取窗口的 10%，是 `validateToolRegistry` 的上限而非实际注册表大小；极少数刚好卡在两者之间的 Context 会比必要更早重建。
- 预算指纹只含 `context_window` 与 `max_tokens`。单独改 `context_stop_ratio` / `hard_token_ratio` 不触发重建，仍由下一次 turn 边界的 GC 处理。
- `/rebuild_context` 不等待被 abort 的 Invocation 完全落定；generation 栅栏保证它不能写回 Context，但它在信号生效前已经排好的 Telegram 发送仍可能发出，与 `/cut_topic` 相同。
- `generation` 检查给每次 `append` 增加一次主键查询；单 Conversation 单写者，成本可忽略。

## 提交

```txt
9199055 Rebuild oversized contexts on model budget changes
```
