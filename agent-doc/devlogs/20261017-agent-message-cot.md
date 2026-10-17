# Plastic Wan - 20261017 Assistant 私有文本区分 CoT 与 response 正文

## 背景

Admin Panel 查看 Invocation 私有文本（Agent transcript / Overview 时间线）时，模型的思考过程（CoT，Pi AssistantMessage 里的 `thinking` 块）与作为一轮 response 的普通文本输出混在一起不可分辨。改动前的实现干脆不落 CoT：`recordAgentMessage` 对 assistant 行硬编码 `thinkingText: ''`，且 SQLite 里还有一条 CHECK 约束（`agent_messages_thinking_empty_check`）禁止非空，等于 thinking 块被 runtime 主动丢弃。

用户明确接受为此做数据迁移。约束：

- canonical history（`context_messages.payload_json`）本来保存完整 thinking 结构，不受影响也不作为本改动的数据来源。
- 不回填旧行：迁移前的行本来就是空 CoT，记录从升级后开始。
- 本次改动分两个提交：主提交 50d587d，e90a3c8 只是 CI 格式修复（见「验证」）。

## 主要变更

### 1. 迁移 035：重建 agent_messages 去掉空 thinking CHECK

SQLite 不能原地修改 CHECK，沿用 `009_harness_nudge.sql` 的表重建模式（[src/store/migrations/035_agent_messages_thinking.sql](../../src/store/migrations/035_agent_messages_thinking.sql)）：rename → 重建（除 thinking CHECK 外，列、`UNIQUE(invocation_id, sequence_no)`、role CHECK、STRICT 全部不变）→ 拷回 → drop 旧表。旧行 `thinking_text` 原样保留空串。`src/store/schema.ts` 同步删掉该 CHECK，让 Drizzle 定义与迁移终态一致。

### 2. runtime 落数：thinking 块单独提取

```ts
// src/orchestration/agent-runtime.ts:1015
const thinking = event.message.content
  .filter((entry): entry is ThinkingContent => entry.type === 'thinking' && entry.thinking.trim().length > 0)
  .map((entry) => entry.thinking)
  .join('\n\n');
this.recordAgentMessage(invocationId, 'assistant', text, thinking);
```

`recordAgentMessage` 增加第四个参数 `thinking = ''`（[:1540](../../src/orchestration/agent-runtime.ts#L1540)），`tool_result`/`harness_nudge` 调用不传，仍是空串。多个 thinking 块用 `\n\n` 连接；全部空白（如 Anthropic 的 redacted thinking）时落空串。

### 3. Admin API 透出 `thinking_text`

`src/ingress/admin/audit.ts` 的 invocation 详情查询与 JSON 增加 `thinking_text` 字段，仅此一处读路径。

### 4. 面板渲染折叠的 CoT 区块

`apps/admin-next/src/pages/invocation-detail.tsx`：Agent transcript 表格的 text 列与 Overview 时间线的 `AgentMessageCard` 都把 `thinking_text` 渲染成折叠的 `LazyDetails`（en: "Thinking (CoT)" / zh-CN: 「思考过程（CoT）」），正文仍标注 Private reasoning（只有 `send` 实发）；行只有 CoT 没有正文时正文位置显示原有的 noText 占位。`apps/admin-next/src/lib/api.ts` 的 `AgentMessageEntry` 加必填 `thinking_text`。

### 5. 测试与 e2e

- `test/agent-runtime.test.ts`：faux 第二轮返回 `[fauxThinking('cot before the answer'), fauxText('private assistant text')]`，断言库中 assistant 行 `text` 与 `thinking_text` 分别落值、非 assistant 行 `thinking_text != ''` 计数为 0。坑：Pi 的 `fauxAssistantMessage` 对数组内容不把裸字符串包成 text 块，裸串会走 toolCall 分支然后 `JSON.stringify(undefined)` 崩掉，fixture 必须显式 `fauxText`。
- `test/admin.test.ts`：详情响应断言 `thinking_text`。
- `test/foundation.test.ts` / `test/scene-retention.test.ts` / `test/long-tasks-migration.test.ts`：写死的迁移计数与 schema 版本 34 → 35。
- E2E 断言 CoT 折叠展开（`apps/admin-next/e2e/03-invocation-detail.e2e.ts`）。共享种子 `test/fixtures/admin-seed.ts` 必须保持 `thinkingText = ''`：`scene-retention` 用同一 fixture 在重放到迁移 029 的历史库上建种，那时的表上还有空串 CHECK，非空会炸；因此在 E2E 专用 server（[apps/admin-next/e2e/server.ts:694](../../apps/admin-next/e2e/server.ts#L694)）单独 UPDATE 出这一行 CoT。

### 6. 文档

`agent-doc/data-layer.md`（agent_messages 语义与分工）与 `agent-doc/admin-panel.md`（Tool session 详情）补充 CoT 单独存储与折叠展示的说明。

## 验证

```bash
pnpm test
# Test Files  105 passed (105)
#      Tests  1352 passed (1352)
pnpm run check
# tsc / admin-next / docs 全部通过
pnpm run lint
# biome lint . 与 biome format . 均无错误
pnpm run admin:test:e2e 01-routes 03-invocation-detail
# 28 passed
git diff --check
# 无输出
```

首次推送后 CI 的 `biome format` 抓到 e2e/server.ts 一行缺分号（`biome lint` 不查这类格式），补分号后两条 workflow 均为 success。

未运行：真实 Telegram 人工验收（配置 reasoning 模型跑一轮带 CoT 的真实调用，在 Admin Panel 肉眼确认折叠除了 e2e 之外的实际效果）。

## 提交

```txt
50d587d Store assistant CoT separately from response text
e90a3c8 Add missing semicolon in e2e server
```
