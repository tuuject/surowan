# Surowan - 20261019 send 失败返回 Telegram 错误描述

## 背景

Invocation 6052 中模型调用 `send` 时给一段纯文本加了 `parse_mode: "MarkdownV2"`，正文里 `SWE-2-high` 的 `-` 和 `5.5` 的 `.` 都没转义，Telegram 返回 400。审计里只留下 `tool_calls.error_code = telegram_400`、`result_text = null`，模型收到的 Tool 结果也只有 `Telegram send failed: telegram_400`。

模型无从区分「MarkdownV2 转义错误」与「被回复的消息不存在」等不同 400，加上 Tool 描述要求不要盲目重试，于是第二轮直接空结束，一条消息都没发出。排查时同样只能靠推断，无法从审计确认 Telegram 拒绝的具体原因。

## 主要变更

### 1. 错误文本附上 Telegram description 并写入审计

`src/capabilities/send-tool.ts:673`：在 send 失败的 catch 分支里先构造一次 `reason`，GrammyError 时在原文本后追加 `(${error.description})`；同一段文本既写入 `tool_calls.result_text`，也作为 Tool 错误抛给模型：

```ts
const reason = held
  ? SEND_BARRIER_TEXT
  : `${unknown ? 'Telegram send outcome is unknown' : `Telegram send failed: ${errorCode}`}${
      error instanceof GrammyError ? ` (${error.description})` : ''
    }`;
// ...
  .set({
    state,
    resultText: reason,
    errorCode,
// ...
throw new Error(reason);
```

- 5xx 的 `outcome_unknown` 也附带 description，但前缀仍是「outcome is unknown」，不鼓励重发。
- `send_reply` 本来就把每条失败的 `error.message` 转述给模型，因此自动带上 description，外层 `send_reply` 行的 `result_text` 仍只记录已发出的 message ID。
- 不新增列、无迁移；`telegram_sends` 继续只记错误码，审计 API 现有的 `tool_calls[].result_text` 即可看到原因。

### 2. 测试与文档

- `test/send-reply.test.ts`：中途失败用例断言模型收到 `telegram_400 (Bad Request: message is too long)`，并断言失败那条 `send` 审计行的 `result_text` 是同一段文本。
- `test/duplicate-send-guard.test.ts`：Telegram 拒绝后可原样重试的用例断言错误包含 `(Bad Request: can not parse entities)`。
- `agent-doc/telegram-agent-flow.md` 的发送失败规则补充 `result_text` 与 description 的记录方式。

## 验证

```bash
pnpm test
# 首次（改测试前）：1456 passed / 1 failed，失败的是 send-reply 中写死旧错误文本的断言
pnpm exec vitest run test/send-reply.test.ts test/duplicate-send-guard.test.ts test/image-delivery.test.ts test/task-context.test.ts test/alarm.test.ts test/context-send.test.ts test/reply-dedup.test.ts
# 7 files, 103 tests passed
pnpm run check
# 通过
pnpm run lint
# biome lint/format：No fixes applied
git diff --check
# 无输出
```

更新断言后没有再跑完整 `pnpm test`。真实 Telegram 环境中模型拿到 description 后能否自行修正转义并重发，尚未验证。

## 提交

```txt
39e9335 Return Telegram error descriptions from failed sends
```
