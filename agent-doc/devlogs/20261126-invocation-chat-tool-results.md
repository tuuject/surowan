# Surowan - 20261126 概览对话视图显示工具结果

## 背景

`20261126-invocation-chat-overview.md` 把运行详情的「概览」改成了对话视图。那一版把 `tool_result` 角色的 Agent 消息当作「读者很少需要」的步骤隐藏，工具结果只剩工具步骤「工具详情」里的 `tool_calls.result_text`。用户看过后要求能查看工具结果。

两份结果并不等价：`tool_calls.result_text` 只在成功时由 `audit.succeed(text)` 写入（`src/store/tool-audit.ts`），失败时只记 `error_code`；模型实际收到的内容，包括失败时的错误说明，在 `agent_messages` 的 `tool_result` 行里（`src/orchestration/agent-runtime/run-hooks.ts:185`，带 `tool_call_id`）。所以失败的工具调用原来在面板上看到的结果是空的。

## 主要变更

### 1. 模型把结果挂到工具步骤和回复上

`apps/admin-next/src/lib/invocation-chat.ts` 按 `tool_call_id` 索引 `tool_result` 消息，工具步骤（`ChatStep.result`）和回复（`reply.result`）都带上 `ToolOutcome`。优先用模型收到的那份，没有时退回调用自己记录的结果，两边都空时为 `null`：

```ts
function toolOutcome(tool: ToolCallEntry, received: AgentMessageEntry | undefined): ToolOutcome | null {
  const text = received !== undefined && received.text.length > 0 ? received.text : tool.result_text;
  const content = received?.result_content ?? tool.result_content ?? null;
  const hasText = text !== null && text.length > 0;
  const hasContent = content !== null && content.length > 0;
  return hasText || hasContent ? { text: hasText ? text : null, content: hasContent ? content : null } : null;
}
```

`tool_result` 消息本身仍是 `secondary` 步骤，不在对话里重复出现；挂在它上面的旧批改意见照常让它显示。

### 2. 视图

- `apps/admin-next/src/components/invocations/step-details.tsx` 的 `ToolStepDetails` 不再把所有内容装进一个「工具详情」：耗时和错误码直接显示，「参数」与「结果」各自是一个按需挂载的展开项。新增 `ToolOutcomeDetails`：有图片等结构化内容时用 `ToolResult`，否则用 `JsonViewer`（JSON 可切树形，纯文本直接显示）；没有结果时显示「没有记录结果」。
- `chat-bubbles.tsx` 的 `BotReply` 在投递信息下方加「结果」展开项；回复没有结果时不显示这一行。
- 文案：四个语言的 `invocations/chat.ts` 去掉 `toolDetails`，新增 `noResult`；「参数」「结果」复用已有的 `toolCall.arguments` / `toolCall.result`。
- 用户指南 `guides/tuning.md`（中英）和 `agent-doc/admin-panel.md` 的文件表同步。

## 验证

```bash
pnpm exec vitest run apps/admin-next/src/lib/invocation-chat.test.ts
# 新用例先写、先失败（execute 失败时拿到的是 null），实现后 9 tests passed
# 覆盖：模型收到的结果优先、失败调用的错误文本、旧数据退回调用自身结果与图片、被拒绝的 send、什么都没记录时为 null

pnpm exec vitest run apps/admin-next/src
# 9 files, 54 tests passed

pnpm run check
# exit 0

npx biome lint . && npx biome format . && git diff --check
# No fixes applied；无输出

pnpm run admin:build && pnpm run admin:test:e2e 41-invocation-chat 03-invocation-detail 34-invocation-review 07-theme 10-developer 13-sender-ids 40-invocation-live-refresh
# 43 passed
# 41：网页抓取步骤先展开「参数」再展开「结果」看到 "Sunny, 22°C"，回复的「结果」是 "sent"
# 03：4002 的失败 read 没有记录结果，显示「没有记录结果」

pnpm run admin:test:e2e
# 391 passed, 1 failed：30-dev-mock，5273 端口被这个 worktree 里一个已在运行的 npm run dev:mock 占用（不是本次启动的，没有停掉它）；单独重跑同样因为端口失败

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两次都 Verified 148 HTML/Markdown pages ... 39 screenshots
```

看过桌面截图：步骤下「参数」「结果」分开展开，回复下的「结果」靠右对齐。

未运行：完整的 `pnpm run docs:screenshots`（公开截图里没有展开的工具步骤，这次不需要重拍）；端口空闲时的 `30-dev-mock`。

## 提交

```txt
51dd3c95 Show tool results on Overview steps and replies
```
