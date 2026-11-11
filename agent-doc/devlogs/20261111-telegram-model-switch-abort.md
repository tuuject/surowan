# Surowan - 20261111 Telegram /model 切换同样立即中止

## 背景

`20261111-model-selection` 让 Admin Panel 的全局与按 Chat 模型切换立即生效：仍在旧模型上的 Invocation 经确认后中止。Telegram `/model` 当时保持原状，切换只影响之后开始的 Invocation。审阅时用户决定 `/model` 也规范成立即中止；管理员发命令本身就是决定，不需要再确认。同时确认 `configure` TUI 将被废弃，不为它补 `models_dev.api_url`。

## 主要变更

### 1. 切换逻辑下沉到 orchestration

`invocationsLeavingModel`、`abortInvocationsLeavingModel`、`withAgentModel`、`withChatModel` 与 `MODEL_SWITCH_ABORT_REASON` 从 `src/ingress/admin/model-switch.ts` 移到 `src/orchestration/model-switch.ts`，让 `bot-commands` 不必向上依赖 ingress。`src/ingress/admin/model-switch.ts` 只保留面板专用的 `MODEL_IN_USE` 与 `modelInUseBody`。

### 2. Chat 范围

新增 `ModelSwitchScope.configuredChatId`：只考虑该配置 Chat（按 `resolveChatConfig`，含迁移 ID）下的 run。Chat 切换会应用整个文件，没有这个范围时，一并应用的手改（例如全局模型）会让别的 Chat 的 run 也被中止。面板 `PUT /chats/:id` 的预检与写后中止也改用该范围。

### 3. `/model` 立即中止

`BotCommandConfigDeps` 增加 `scheduler`。`switchChatModel` 在 `setChatModel` / `resetChatModel` 应用成功后，以命令开始时的配置为 `before` 调用 `abortInvocationsLeavingModel(..., { configuredChatId })`。回执由「将在下一次 agent session 生效」改为「已写入 config.jsonc 并立即生效」/「已立即生效」；有中止时多一行「已终止 N 个仍在使用旧模型的会话，它们正在处理的消息不会再得到回复。」。`/effort` 不变（只改 thinking，不中止）。

### 4. 文档

`agent-doc/admin-panel.md`「模型切换立即生效」、`agent-doc/configuration.md`、`agent-doc/telegram-agent-flow.md` 的 `/model` 段，以及用户手册 `configure/models.md`、`configure/telegram.md`、`guides/per-chat.md` 同步。

## 验证

```bash
pnpm vitest run test/bot-commands test/admin/model-switch.test.ts
# 9 files / 56 tests passed（加新用例前）。
pnpm vitest run test/bot-commands/service-model.test.ts
# 9 tests passed。新用例：两个 Chat 各有一个运行中的 Invocation，文件里还有一处待应用的全局模型手改；
# `/model 2` 只中止本 Chat 的 run（model_switched），另一个 Chat 虽然随手改换到新全局模型仍正常完成；
# `/model default` 回到没人在用的全局模型时不中止、不报告。

pnpm test
# 369 files / 1771 tests passed，505.73s。

pnpm exec biome lint . && pnpm exec biome format . && git diff --check
pnpm run check
# 通过。

pnpm run admin:test:e2e 08-models 09-chats
# 37 passed（前端未改动，覆盖重构后的 PUT /model 与 PUT /chats/:id）。

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 50 个页面与 164 个 HTTP 资源。
```

## 未执行

真实 Telegram 群聊里 `/model` 中止进行中会话的验收。

## 提交

```txt
f5670d15cfdbe5c9b4492126810df9a19000ea57 Stop runs on the old model when /model switches a Chat
```
