# Surowan - 20261104 空文本发送的三态策略

## 背景

模型偶尔调用 `send` / `send_reply` 时漏掉 `text`，把一次文本发送变成空调用。早期行为是以 `send_input_invalid` 拒绝；后来加了可选的随机文本兜底（`send_empty_text_fallback_enabled` + `send_empty_text_fallback_texts`），把异常调用转成一条真实消息。

随机文本会额外制造群聊内容，也可能引来模型对自己兜底消息的解释。需求是把处理方式扩展成三态：`reject`（默认，保持原行为）、`silent_success`（返回成功但不发送）、`random_text`（现有随机兜底）。同时要求静默成功不能绕过连续未发送熔断，旧配置升级后行为不变。

## 决策

**新字段显式优先，旧布尔只做兼容输入。** 配置新增 `agent.send_empty_text_strategy`，`AgentRuntimeConfig` 解析后总是具体值。旧字段 `send_empty_text_fallback_enabled` 继续被 schema 接受，但只在策略缺省时参与解析：`true` 解析为 `random_text`，否则 `reject`。这样已有配置文件不需要迁移，显式策略又能覆盖旧开关。

**静默成功在 Tool 入口短路，不进入发送管线。** `isMissingTextSend` 复用 `narrowSendInput`，只有「解析为文本且唯一问题是缺 `text`」才返回 true；文本带 `resend: true`、Sticker 缺 `sticker_ref` 等其他形状错误仍照常拒绝。静默路径只写一条 `tool_calls` 成功审计（`side_effect = 0`），不写 `host_sends`、不占发送额度、不触发 Reply 去重、重复发送守卫或 send 屏障。

**`send_reply` 逐 part 跳过。** 缺文本的 part 各记一条成功审计，其余 part 继续走完整管线；`reply_to_message_id` 落到第一条真正发出的 part，限流预算也只按实际要发的条数计算。全部 part 都缺文本时整组成功、零发送。

**熔断单独计数，但沿用三次规则。** `RunState` 新增 `consecutiveSilentSends`：每次静默成功加一，任何真正发布的消息清零，注入新批次不清零。`finishTurn` 在计数达到 `SILENT_SEND_LIMIT = 3` 时以新的 `completion_reason = silent_send` 结束运行。没有复刻 `repeated_tool_failure` 的签名比较，因为静默成功返回的是 success，失败熔断永远看不到它；重放使用同一计数与阈值。

**Admin Panel 换下拉框，并在保存时清理旧字段。** Harness 页把原来的布尔开关替换为 `reject` / `silent_success` / `random_text` 选择。读回时旧开关为 `true` 且策略缺省则报告 `random_text`；首次保存策略时同时删除 `send_empty_text_fallback_enabled`，避免旧值日后重新生效。

## 主要变更

### 1. 配置

- `src/platform/config/schema-sections.ts:83` 新增 `EmptyTextSendStrategySchema`，`:106` 注册 `send_empty_text_strategy`。
- `src/platform/config/resolve.ts:84` 按「显式策略 > 旧开关 > `reject`」解析。
- `src/platform/config/index.ts:70` 让运行时配置始终携带具体策略；旧字段保留在文件形状里。
- `src/platform/config/diff-merge.ts:31` 把新字段加入热更新白名单；`src/ingress/admin/config-inspection.ts` 同步展示。

### 2. send 与 send_reply

`src/capabilities/send/support.ts`：

- `effectiveEmptyTextStrategy` 兼容只有 fallback 列表、没有策略字段的旧调用方。
- `isMissingTextSend` 只认缺 `text` 这一个问题。
- `silentSendText` 生成「已处理但未发布消息」的结果文案。
- `emptyTextHandling` 把解析后的策略与兜底文本装进 Tool 环境。

`src/capabilities/send/index.ts:112` 的 `send` 在静默策略下直接记录审计并返回；`send_reply` 从 `:149` 起先分区出要发的 part，再只对它们执行原有预检、限流与交付。发送成功后 `publishSend` 通过 `onSendOutcome('published')` 复位熔断计数。

### 3. 运行时熔断

- `src/orchestration/agent-runtime/types.ts:125` 新增 `silent_send` 停止原因，`RunState` 新增连续静默计数。
- `src/orchestration/agent-runtime/run-agent.ts` 把 send 结果回调接到计数上。
- `src/orchestration/agent-runtime/run-turns.ts:133` 在三次后结束运行。

### 4. 重放

`src/orchestration/replay/tools-send.ts` 与 `run.ts` 同步三态策略：静默调用只记 dispatch、不产生合成 send；连续三次静默同样以 `silent_send` 结束重放。

### 5. Admin Panel

- `src/ingress/admin/harness.ts` 增加枚举字段、旧开关推导，以及写策略时删除旧字段的编辑。
- 前端 Harness 页新增 `select` 字段类型与下拉渲染；`HarnessValue` 支持字符串。
- 中英文 locale 增加策略与选项文案。

## 测试与文档

- `test/send/empty-text-strategy.test.ts`：静默 `send` 零发送、审计 `success` + `side_effect = 0`、`send_reply` 混合/全空 part、其他形状错误仍拒绝、带文本发送照常。
- `test/agent/runtime-empty-text-strategy.test.ts`：真实 Invocation 连续三次静默 `send` 以 `silent_send` 结束；中间成功发布一条消息后计数清零。
- `test/config/boundary.test.ts`：默认 `reject`、旧开关 `true` 映射 `random_text`、显式策略优先。
- `test/admin/harness.test.ts`：策略写入与热应用、旧开关读回与保存后清理、非法枚举拒绝。
- `test/replay/tools.test.ts`：重放静默策略不产生合成输出。
- 文档：`apps/docs` 用户手册与示例配置、`agent-doc/configuration.md`、`telegram-agent-flow.md`、`admin-panel.md`、`verification.md`。

## 验证

```bash
pnpm run lint
# biome lint + format 通过

pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm vitest run test/send/empty-text-strategy.test.ts test/send/empty-text-fallback.test.ts \
  test/send/reply.test.ts test/agent/runtime-empty-text-strategy.test.ts \
  test/agent/runtime-duplicate-sends.test.ts test/admin/harness.test.ts \
  test/replay/tools.test.ts test/replay/tools-guards.test.ts \
  apps/admin-next/src/lib/harness.test.ts
# 9 files / 70 tests passed

pnpm run admin:build && pnpm run admin:test:e2e 19-harness
# 6 passed

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，48 页面 / 158 资源
```

完整 `pnpm test` 跑过两次：第一次只有新加的 `platform/config` 类型导入触发重放源码守卫（改为从 `send/support` 取类型后复跑通过）；第二次 370/371 文件通过，唯一的 `test/playground/context.test.ts` 失败单独复跑 9/9 通过，与本改动无关。

## 提交

```txt
82444bb Add configurable empty-text send strategies
```
