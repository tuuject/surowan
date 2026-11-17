# Surowan - 20261118 `/ask` 显式唤起与 ask-only 参与模式

## 背景

用户审定的 PRD `doc/design/20261117-ask-command.md`：让更多群友接受 LLM 群宠，先从显式互动开始。管理员可以把群设成完全不被群友消息触发的模式，群友用 `/ask` 显式唤起；开了 `/ignoreme` 的群友也能用 `/ask` 互动。

改动前的状态：

- 参与闸门最多收窄到「活跃时段外，只有 @、回复 Bot、关键词能开 Bucket」，唤起后还有注意力窗口，窗口内其它消息也能触发。没有「完全不被触发」这一档。
- 现有 Bot 命令全部由 Bot 自己给出固定回复，命令消息不作为聊天消息入库，startup catch-up 只重放 `/pause`、`/resume`。`/ask` 是第一条要把内容交给模型的命令。
- `/ignoreme` 成员的消息在入库前就被丢弃，模型看不到。
- `appendToBucket` 新开 Bucket 时会收养此前没进过 Bucket 的其它 Bot 消息，也会让任何后续消息加入正在 collecting 的 Bucket。
- `conversation_attention.trigger_kind` 有 `IN ('mention','reply_to_bot','keyword')` 的 CHECK。
- 主动回复闸门 `ProactiveReplyGate` 按 Bucket 里消息当前 revision 的原始片段判断是否 direct；不是 direct 的批次要过概率抽样，可能被跳过。

由 T3 委派 Codex（`gpt-6.1-sol`，reasoningEffort `high`）在子线程「Implement /ask explicit invocation and ask-only participation mode」里实现。主会话负责写任务说明、读 diff、跑 ocr、核实意见、打回修正、独立复验和交付。

## 主要变更

### 1. `/ask` 识别：`src/platform/bot-command.ts`

- `botCommandToken()`（`:4`）是控制命令与 `/ask` 共用的分词：只认 `text` 偏移 0 的 `bot_command` 实体，`@` 后缀必须是本 Bot。`parseBotCommand()` 改为调用它，控制命令的行为不变。
- `isAsk()`（`:23`）额外放行 `sender_chat`：匿名管理员和频道身份的 `from` 是 GroupAnonymousBot 这类占位 Bot，`parseBotCommand` 会拒收，`/ask` 不能因此失效。真正的其它 Bot 发 `/ask` 不触发。
- `isOriginalAsk()`（`:31`）要求片段没有 `edit_date`。原消息从未收到时，`storeMessage` 会把一条 `edited_message` 存成 revision 1，不能把它当成新的 `/ask`。
- `/ask` 写进 `BOT_COMMANDS` 菜单（`src/orchestration/bot-commands/index.ts:114`），但不进 `COMMAND_NAMES`、不经过 `BotCommandService`。`registerBotCommands()` 的自检对它单独放行。

### 2. 入库与触发：`src/ingress/telegram-ingestion/index.ts`

- 被忽略成员的新消息只要是 `/ask` 就照常入库（`:153`），其它消息和编辑仍在入库前丢弃。
- `matchTriggerKind()`（`src/platform/participation.ts`）新增最高优先级的 `'ask'`。普通群里 `/ask` 和 @ 走同一条路：活跃时段外也能开 Bucket，刷新注意力窗口（`trigger_kind = 'ask'`），用配置的 Bucket 节拍。
- 进入 Bucket 的 `/ask` 和 @ 一样显示「正在输入」（`:209`，仍受 `mention_typing_enabled` 控制）。
- 迁移 `src/store/migrations/063_ask_participation.sql` 重建 `conversation_attention`，CHECK 加入 `'ask'`，保留现有行和过期索引；`src/store/schema/core.ts` 同步。

### 3. ask-only 模式

- 配置：`ParticipationSchema` 新增 `ask_only?: boolean`，全局 `telegram.participation` 与 `telegram.chats[].participation` 都能写，Chat 的显式 `false` 覆盖全局 `true`。`compileParticipation()` 在只写了 `ask_only: false` 且没有其它时段字段时返回 `undefined`，不会把群误变成「仅触发」。私聊不受影响，沿用原有规则。热应用沿用 `HOT_PARTICIPATION_PATHS`。
- 闸门：`evaluateParticipation()`（`src/store/participation.ts:133`）在 ask-only 下只放行 `'ask'`，不写注意力窗口；活跃时段、关键词和窗口长度在这一模式下都不起作用。
- 入桶：ask-only 下被闸门拒绝的消息根本不调用 `appendToBucket`（`index.ts:193`），所以普通消息、@、回复、关键词、其它 Bot 消息都只入库，不加入任何 Bucket，包括还在 collecting 的 `/ask` Bucket。`/ask` 新开的 Bucket 节拍是 `0/0/0`，不收养待处理的 Bot 消息（`buckets.ts:77`、`:100`）。
- 已有 collecting Bucket 时，后来的 `/ask` 并入它。每个 Conversation 只有一个 collecting Bucket，模型能同时看到两条 ask，这一点是有意接受的。
- `/status` 显示「参与模式：仅 /ask 唤起」（`src/orchestration/bot-commands/status.ts:139`）。

### 4. 主动回复闸门：`src/orchestration/proactive-reply.ts:126`

消息原始的非编辑 revision 是 `/ask` 时，整个批次就算 direct，绕过概率抽样。@、回复、关键词照旧看当前 revision，`matchTriggerKind(..., false)` 不再从当前 revision 识别 ask。这样 `/ask` 在等待期间被改成普通文本，也不会被抽样跳过；普通消息被改成 `/ask` 也不会变成唤起。

### 5. catch-up：`src/orchestration/invocation-queue/catch-up.ts`

- ask-only 的 Conversation 另外用 `selectCatchUpAsks()`（`:123`）分页倒序扫描 backlog，最多取 `history_messages` 条原始 `/ask`，普通消息再多也挤不掉 ask。
- 排队的 ask-only 批次只包含这些 `/ask`，并以 `includeHistory = true` 入队（`:270`），downtime 里的普通消息作为 `history` 冻结进快照。普通 catch-up 仍然把整段 backlog 作为 new 消息、不带 history。
- 没有 `/ask` 的 ask-only backlog 照旧记成 `participation_gated` 跳过 Bucket，并保留整段 backlog 作为审计内容。

### 6. Admin Panel / CLI / MCP

- `PUT /chats/:id/participation` 拆到 `src/ingress/admin/chat-participation.ts`（`src/ingress/admin/chats.ts` 已接近 20 KB 的提交上限）。body 是 `{ active_windows?, ask_only? }`，至少一项，`null` 删除覆盖，省略就保留；旧的 `{ active_windows }` 照常可用。按字段输出子路径编辑，不整段替换 `participation`，这样手写在 JSONC 里的注释不会丢；结果为空时才删掉整个对象。私聊一律拒绝。
- 参与方式对话框新增第四个选项「仅 /ask 唤起」，会考虑全局 `ask_only`：全局开着时选其它模式会写入 `ask_only: false`。列表摘要显示有效模式。四个 locale 都补了文案，e2e `09-chats-active-hours` 覆盖开启和关闭。
- `packages/admin-surface/src/specs/chats.ts` 的命令摘要，以及 `skills/surowan-mcp/references/tools.md` 的 body 说明，都同步更新。

### 7. 文档

用户指南 `guides/participation.md` 与 `configure/telegram.md`（命令表、typing 段落）、产品知识 `src/platform/prompts/2-product-knowledge.md`（只刷新相关条目）、`AGENTS.md` 的参与概述，以及 `agent-doc/` 的 telegram-agent-flow、configuration、data-layer、admin-panel、verification 都已更新。没有加强制模型回答 `/ask` 的 prompt 规则，是否发言仍由模型决定。

## Review 与修正

AI review 只做一轮：ocr 报 6 条，1 条 low（对话框里的嵌套三元）直接丢弃。另外 1 条（第二个 `/ask` 并入 collecting Bucket）属于任务说明里接受的设计，没有改。其余 4 条加上主会话读 diff 发现的 2 条，核实后都成立，打回同一子线程修正：

1. ask-only catch-up 批次只剩 `/ask`，又不带 history，模型看不到 downtime 的上下文 → 改为带 history 入队；
2. `/ask` 被 `history_messages` 截断挤掉 → 用 `selectCatchUpAsks()` 独立选取；
3. revision 1 可能是编辑 → 增加 `isOriginalAsk()`，检查 `edit_date`；
4. 主动回复闸门看当前 revision，`/ask` 被编辑后可能被抽样跳过 → 改看原始非编辑 revision；
5. Admin patch 整段替换 `participation`，丢失 JSONC 注释（主会话发现）→ 改为按字段写子路径；
6. ask-only 下 `participation_gated` 跳过的 Bucket 没有任何消息（主会话发现）→ 跳过时保留整段 backlog。

修正轮没有再跑 AI review。主会话读新 diff 逐条核对，确认没有改动「不要改」里列出的三项。

## 验证

基线：在 base `a4fa653e` 上跑 `pnpm test`（与子 agent 同时运行，机器负载较高），有 11 个用例 `Test timed out in 5000ms`：`group-memory/store`、`playground/context`（5 个）、`playground/only-serve`（3 个）、`startup/catch-up`、`tasks/long-tasks`。

快速层（首轮），主会话亲自运行：

```bash
pnpm run lint && pnpm run check
pnpm test test/participation test/bot-commands test/proactive test/startup test/admin/chats-participation.test.ts test/schema/migrations-ask.test.ts test/scheduler
# 28 files / 165 tests passed
```

完整层（修正轮后），主会话亲自运行：

```bash
node scripts/file-token-limit.ts && git diff --cached --check
pnpm run lint && pnpm run check
# exit 0
pnpm test test/participation/ask.test.ts test/participation/ask-catch-up.test.ts test/proactive/ask.test.ts test/admin/chats-participation.test.ts test/schema/migrations-ask.test.ts   # 连跑 3 次
# 每次 5 files / 24 tests passed
pnpm test
# Test Files 1 failed | 411 passed | 1 skipped (413)
# Tests 1 failed | 2048 passed | 9 skipped (2058)
# 唯一失败：test/playground/only.test.ts 超时 5000ms；单独重跑 1 passed，与基线中的超时属于同一类
pnpm run admin:build
pnpm run admin:test:e2e 09-chats 01-routes
# 37 passed
DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify          # PowerShell
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify  # PowerShell
# 两种 base 均 exit 0，构建后工作区没有多出的文件
```

rebase 到 `origin/develop`（`c303eafe`，含 CJK 感知的 token 估算）后，主会话重跑：

```bash
pnpm run lint && pnpm run check
pnpm test test/manual-pack.test.ts test/context test/prompts test/skills.test.ts test/participation test/proactive test/startup test/bot-commands test/admin/chats-participation.test.ts test/scheduler test/schema test/foundation
# 73 files / 355 tests passed
```

只有子 agent 自报、主会话没有复现的：修正轮新增的回归测试在修复前会失败（自报 7 项预期失败）；`admin:test:e2e 09-chats --repeat-each 3`。

未执行：真实 Telegram 群里的人工验收（`/ask` 菜单注册、匿名管理员 `/ask`、ask-only 群的实际唤起）；rebase 后没有再跑全量测试；Linux CI 上的全量测试。

## 提交

```txt
e18e54ea Add /ask command and ask-only participation mode
```
