# Surowan - 20261018 重复发送保护：同一 Invocation 内拒绝原样重发

## 背景

线上 Invocation 5943：`openai/gpt-6-luna`（thinking off）对一张无文字图片（消息 38785）用完全相同的文本连续 `send` 了 24 次，每次 Telegram 都成功接受，直到 `turns_per_injection = 24` 才停下。几道已有的防线都没起作用：

- **Reply 去重被关掉了**：线上配置 `allow_reply_message_multiple_times: true`，所以按 `reply_to_message_id` 去重的 `rejectDuplicateReply` 整个被跳过。
- **`repeated_tool_failure` 熔断只看失败调用**（见 `890bed6`）：24 次都成功，熔断永远不会触发。
- **发送限流太宽**：`sends_per_window = 100`，24 条远远够不着。

缺的就是一条针对“成功发送被原样重复”的规则。需求：同一 Invocation 里已经成功发过完全一致的消息，就拒绝；因为这个原因被拒超过 3 次，就强制结束本轮；做成开关，默认开启，在 `config.jsonc` 里可选。

## 主要变更

### 1. send 管线的重复判断

`src/capabilities/send-tool.ts` 给 `SendToolEnvironment` 加了可选的 `duplicateSendGuard: { onRejected }`，并导出两个小工具：

```ts
export const DUPLICATE_SEND_REJECTION_LIMIT = 3;
export function duplicateSendGuard(enabled: boolean | undefined, onRejected: () => void = () => {}) {
  return enabled === false ? {} : { duplicateSendGuard: { onRejected } };
}
```

判断在 `isDuplicateSend`（`src/capabilities/send-tool.ts:926`）：在本 Invocation 的 `tool_calls` 里找 `tool_name = 'send'`、`state = 'success'`、`side_effect = true`，并且 `arguments_json` 等于收窄后输入的 `JSON.stringify`。比较的是 `narrowSendInput` 之后的形状，所以：

- kind、文本或贴纸、`parse_mode`、`reply_to_message_id` 全部相同才算重复；省略 `kind` 或附带另一种 kind 的无关字段，都不会让同一条消息“变成”另一条。
- 只有 Telegram 真正接受过的才算数。被 Telegram 拒绝（例如 400 解析失败）的调用状态是 `error`，可以原样重试。
- 图片豁免：同一个 generation 后来多出来的图片需要能再交付，图片继续走原来按 asset 的去重。

`deliver` 在图片分支之后、`rejectDuplicateReply` 之前检查（`src/capabilities/send-tool.ts:450`）。命中时记一条 `send_duplicate` 拒绝，调用 `onRejected()`，然后抛出给模型看的说明：消息已经发过，不要再发；没有别的要说就直接结束。拒绝不调用 Telegram，不写 `telegram_sends`，也不占 `sends_used`。

`send_reply` 的整组预检（`src/capabilities/send-tool.ts:773`）用 `partKeys` 同时挡两种情况：和本轮已发消息重复，以及和同一组里前面的条目重复。任何一条命中，整组都不发。它发出去的每一条也算本轮的 send，之后单独 `send` 同样内容也会被拒。

守卫开启时，`send` 的描述里多一句 “A text or sticker identical to one already sent in this run is rejected; never repeat a message that was sent.”，提前告诉模型规则。

### 2. 超过 3 次就停

`src/orchestration/agent-runtime.ts`：`StopReason` 新增 `'duplicate_send'`；`RunState.duplicateSendRejections` 在每次拒绝时 +1，整轮运行不清零。`finishTurn` 在 `repeatedFailure.observe` 之前检查（`src/orchestration/agent-runtime.ts:926`），大于 `DUPLICATE_SEND_REJECTION_LIMIT` 就 `stop('duplicate_send')`，也就是第 4 次拒绝后在 turn 边界结束。

“超过 3 次”按字面理解，取 `> 3`。和 `repeated_tool_failure` 的关系：模型像 5943 那样一直连发同一句时，连续三次一模一样的失败调用会先触发熔断，结束原因是 `repeated_tool_failure`，Telegram 上只出现 1 条。`duplicate_send` 主要拦的是交替重复（a、b、a、b……）这种每轮调用都不一样、绕开熔断的情况。

`validateAdditionalTools` 也带上守卫，保证校验时看到的工具描述和真实运行一致。

### 3. 重放对齐

- `src/orchestration/replay-tools.ts`：合成 `send` / `send_reply` 在 dispatch 记账之后、`checkReplayReplyUnused` 之前调用 `checkReplayNotDuplicate`（`src/orchestration/replay-tools.ts:341`）。`duplicateKey` 先用 `SendInputValidator.Check` 校验，再 `narrowSendInput`，图片同样豁免。
- `src/orchestration/replay.ts`：场景级计数 `duplicateSendRejections`，`finishTurn` 里超过上限就以 `completion_reason = 'duplicate_send'` 结束（`src/orchestration/replay.ts:443`）；`#defaultRegistry` 构造的 send 工具也带上守卫。

### 4. 配置开关

- `src/platform/config.ts`：`agent.send_duplicate_guard_enabled: Type.Optional(Type.Boolean({ default: true }))`。加载时不应用 Schema 默认值，运行时统一用 `!== false` 把未设置当作开启。
- `src/platform/config-diff.ts`：加入 `HOT_PATHS`，可以热应用。
- Admin：`harness-admin.ts` 用 `field(..., true)` 暴露，未设置读出来是 `true`，写入 `true` 时不往文件里写；`config-inspection.ts` 回显该字段；前端 `apps/admin-next/src/lib/harness.ts` 放在发送分组，en/zh-CN 文案都补上了。
- 文档：`agent-doc/configuration.md`（热更新列表加字段说明）、`agent-doc/telegram-agent-flow.md`（防失控说明与 send Tool 小节）、`agent-doc/verification.md`、用户指南 `apps/docs/content/docs/configure/telegram.md`、`apps/docs/examples/config.example.jsonc`。

### 5. 测试

- 新增 `test/duplicate-send-guard.test.ts`（6 条）：默认开启；相同文本被拒且不到 Telegram，不同 Reply 目标或 `parse_mode` 不算重复，无关字段不影响判断，拒绝不占额度；贴纸重复被拒；Telegram 400 之后可原样重试；`send_reply` 条目与之前发送或组内前面的条目重复被拒；关闭后可以重复发送，描述里也没有守卫那句。
- `test/agent-runtime.test.ts:571`：按 5943 的形状连续 10 次 `sunrise`，断言只发出 1 条，结束原因 `repeated_tool_failure`，`error_code` 依次为 `[null, send_duplicate ×3]`。`:584`：a/b 交替 ×4，以 `duplicate_send` 结束，只发出 `['a', 'b']`。`:591`：守卫关闭时同一句发两次，正常完成。
- `test/replay-tools.test.ts:162`、`test/replay.test.ts:1034`：场景内拒绝与豁免、重放以 `duplicate_send` 结束（`model_calls = 6`、`send_count = 2`）。
- `test/admin-harness.test.ts`：未设置读作 `true`；写入 `false` 后热应用，`applied` 包含 `agent.send_duplicate_guard_enabled`；字段未设置时写入 `true` 不改文件。
- 被新守卫影响的旧用例：`test/task-context.test.ts:403` 的限流用例原本连发同一句，改为 `result 1`、`result 2`……，确保它测的仍然是限流本身；`apps/admin-next/src/lib/harness.test.ts` 的 `saved` 补上新字段。

## 验证

```bash
pnpm test
# Test Files  111 passed (111)
# Tests  1407 passed (1407)

pnpm run check          # 通过
pnpm run lint           # lint:fix 重排了 3 个文件后通过
git diff --check        # 通过
pnpm run admin:build && pnpm run admin:test:e2e
# 156 passed
pnpm run docs:build && pnpm run docs:verify   # 通过
```

未覆盖：没有在真实 Telegram 上验收，也没有对 5943 做付费重放。线上部署后可以观察有没有出现 `error_code = send_duplicate` 的 Tool Call，或者 `completion_reason = duplicate_send` 的 Invocation。线上配置的 `allow_reply_message_multiple_times: true` 没有改，新守卫不依赖它。

## 提交

```txt
f582440 Reject duplicate sends within an invocation
```
