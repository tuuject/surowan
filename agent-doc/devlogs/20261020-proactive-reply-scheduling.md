# Plastic Wan - 20261020 群聊主动回复概率调度

## 背景

塑料碗在活跃群里会对每个可触发批次创建 Invocation，模型因此有较多机会主动插话。产品定位是「赛博群友」，不是每条群消息都要回应的自动应答机器人，但也不能因为随机运气差而长期完全不参与。

需要把 **普通群聊消息** 的参与改成带硬保底的概率调度，同时保持直接唤起语义不变：@ Bot、回复 Bot 自己发过的消息、命中触发关键词和 Telegram Bot Command 都不应被概率拦截，也不应影响保底计数。

概率调度只决定是否给一次 Agent Invocation 机会，不保证模型最终调用 `send`。调度必须发生在 Invocation 创建之前，不能为此额外调用 LLM；未命中的消息仍要按现有规则入库并进入后续 Context。

## 主要变更

### 1. 独立的概率策略与决策层

`src/platform/proactive-reply.ts` 只做配置合并与纯计算：默认 `enabled = false`、`base_probability = 0.2`、`increment = 0.1`、`hard_pity = 8`，全局与 Chat 覆盖逐字段继承：

```ts
export const PROACTIVE_REPLY_DEFAULTS: ProactiveReplySettings = {
  enabled: false,
  base_probability: 0.2,
  increment: 0.1,
  hard_pity: 8,
};
// ...
return {
  enabled: local?.enabled ?? global?.enabled ?? PROACTIVE_REPLY_DEFAULTS.enabled,
  base_probability: local?.base_probability ?? global?.base_probability ?? PROACTIVE_REPLY_DEFAULTS.base_probability,
  increment: local?.increment ?? global?.increment ?? PROACTIVE_REPLY_DEFAULTS.increment,
  hard_pity: local?.hard_pity ?? global?.hard_pity ?? PROACTIVE_REPLY_DEFAULTS.hard_pity,
};
```

第 `attempt` 次连续抽样（从 1 开始）的概率与硬保底：

```ts
export function proactiveReplyProbability(attempt: number, settings: ProactiveReplySettings): number {
  if (attempt >= settings.hard_pity) {
    return 1;
  }
  return Math.min(1, Math.max(0, settings.base_probability + Math.max(0, attempt - 1) * settings.increment));
}
```

`sampleProactiveReply` 接收可注入的 `random`，测试因此可以确定性地覆盖概率边界和保底；到达 `hard_pity` 时直接命中，不依赖随机数结果。

### 2. 在 Bucket 到期、创建/attach 之前抽样

`src/orchestration/proactive-reply.ts:43` 的 `ProactiveReplyGate.decide` 是唯一决策点。它先跳过私聊与关闭状态，再扫描该 Bucket 的冻结消息；有直接唤起则整批绕过，否则读取该 Chat 的连续未命中数并抽样：

```ts
if (options.chatType === 'private') {
  return { allowed: true, reason: 'disabled', triggerKind: null };
}
const settings = resolveProactiveReply(this.#configStore.current().config, options.chat);
if (!settings.enabled) {
  return { allowed: true, reason: 'disabled', triggerKind: null };
}
const triggerKind = this.#directTriggerKind(options.bucketId, options.keywords);
if (triggerKind !== null) {
  // 直接唤起：记录 bypass，不读写 proactive_reply_state
  return { allowed: true, reason: 'direct', triggerKind };
}
// 读取 state -> sampleProactiveReply -> upsert 新计数与 fingerprint
```

直接唤起扫描只取仍在 Bucket 里、可见、非 Bot、非 Bot 自己发送、且具备文本/ caption / Reply 目标的消息，再复用 `matchTriggerKind` 判定 mention → reply_to_bot → keyword。这样一条聚合批次里任意一条直接消息都会让整批通过，不会因为后面的普通消息把机会吃掉。

`src/orchestration/invocation-queue.ts` 在两个地方接入：

- `#queueBucket`：通过现有聊天、Agent、睡眠闸门后，再调用 `#proactiveAllows`；未命中则 `#markBucketSkipped(bucket.id, now, 'proactive_reply_skipped')`，不创建 Invocation。
- `#attachBucket`：长活 Invocation 接收新批次前同样先抽样；未命中不 attach，Bucket 关闭为 `skipped_budget`。

启动追赶也走同一判断（`finishStartupCatchUp`），因此停机期间积压的普通消息不会绕过概率；其中包含直接唤起时仍整批放行。任务回执与 Bot Command 不经过这条链路。

### 3. 按 Chat 持久化保底计数

新增迁移 `src/store/migrations/036_proactive_reply.sql`：

```sql
CREATE TABLE proactive_reply_state (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  consecutive_misses INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_misses >= 0),
  settings_fingerprint TEXT NOT NULL,
  last_sampled_at TEXT NOT NULL
) STRICT;
```

- 计数按 Chat 而不是 Conversation，同一群的 Forum Topic 共享一个保底。
- 每个 Bucket 最多一次写入；抽样与 Bucket 状态转换在同一个 SQLite 事务内完成。
- `settings_fingerprint` 只包含三个数值参数，`base_probability` / `increment` / `hard_pity` 变化后下一次抽样先清零；仅开关 `enabled` 或重启保留。
- 未命中的 Bucket 仍保留 `bucket_messages`，消息会在后续 Invocation 里作为 history 出现，不会丢消息。

### 4. 配置、管理面板与日志

`src/platform/config.ts:177` 新增 `ProactiveReplySchema`，挂在 `telegram.proactive_reply` 与 `telegram.chats[].proactive_reply`；正数 Chat ID（私聊）配置会被 `check-config` 拒绝。`config-diff.ts` 把两级的所有子字段标为热更新。

Admin Chats 页新增「主动回复」列、摘要和星形编辑按钮（`apps/admin-next/src/pages/chats.tsx:506`），对话框支持：

- 跟随全局；
- 关闭本群主动回复；
- 自定义首次机会、每次增加和最多尝试次数。

新增 `PUT /api/chats/:id/proactive-reply`（`src/ingress/admin/server.ts:1380`、`src/ingress/admin/chats-admin.ts:225`），保存后热应用，不需要重启。输入用百分比展示，但写入配置时转换为 0–1。

日志只写标准输出，不落长期审计表：

- `agent_proactive_reply_bypassed`：直接唤起，带 `trigger_kind`。
- `agent_proactive_reply_sampled`：带 `attempt`、`probability`、`consecutive_misses_before/after`、`hit`、`hard_pity`、`state_reset`。

### 5. 测试与文档

`test/proactive-reply.test.ts` 覆盖默认关闭、概率递增、硬保底、命中重置、聚合批次一次抽样、批次内直接唤起、@/Reply/关键词/Bot Command、直接唤起不改变计数、按群隔离、重启恢复、参数变化清零、开关保留计数、attach 前抽样，以及私聊/暂停/participation 边界。`test/startup-catch-up.test.ts` 增加追赶批次抽样；`test/admin-chats.test.ts` 与 `09-chats` e2e 覆盖面板写入和三种模式。

文档同步更新 `agent-doc/configuration.md`、`telegram-agent-flow.md`、`data-layer.md`、`admin-panel.md`、`verification.md`，用户手册新增 `apps/docs/content/docs/guides/proactive-replies.md`。

## 验证

```bash
pnpm run check
# 通过

pnpm test
# 116 test files passed, 1476 tests passed

pnpm run admin:build
pnpm run admin:test:e2e 09-chats
# 10 passed

pnpm run docs:build && pnpm run docs:verify
# Verified 24 HTML/Markdown pages, search, examples, schema, provenance and 86 HTTP resources

./node_modules/.bin/biome lint src test apps/admin-next/src apps/admin-next/e2e
./node_modules/.bin/biome format src test apps/admin-next/src apps/admin-next/e2e
git diff --check
# 无报告
```

## 提交

```txt
99a48e9 Add proactive reply probability scheduling
```
