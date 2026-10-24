# Surowan - 20261019 重复发送守卫：拦截把上一条内容改投其他引用目标

## 背景

线上 Invocation 6035 里，模型把同一句「窝可不是土木人……」先回复了消息 `39162`（`send` 成功，`39163`），紧接着又原样回复 `39161`（同样成功，`39164`），群里出现两条一模一样的消息。直到第三次再回 `39161` 才被 `send_duplicate` 拦下，之后的尝试都撞上了 `reply_already_sent`。

原因是 `isDuplicateSend` 用整条归一化输入 `JSON.stringify(send)` 比对，`reply_to_message_id` 和 `parse_mode` 都在里面：只要换个引用目标就不算重复。`send_bypass` 也拦不住，因为它只管被 Reply 去重拒过的内容，而这句话在第二次发出前从没被拒过。手册当时也写明「换个说法或回复别的消息不受影响」。

直接改成全程只按内容判重会误伤合理的短句复现（隔一会儿再说一句「好」）。所以只追加一条更窄的规则：**只和本次运行上一条成功发送比内容**。这正好覆盖「同一句话挨个回复不同的人」，A → B → A 交替仍交给原有的逐字比对与 Reply 去重兜底。

## 主要变更

### 1. `repeatsLastSend`：只比上一条的内容

`src/capabilities/send-tool.ts:1004` 新增 `repeatsLastSend`：取本 Invocation 最后一条 `tool_name = send`、`state = success`、`side_effect = 1` 的审计行，用已有的 `sendContentKey`（kind + 文本或贴纸 file id，不含引用目标与 `parse_mode`）比对：

```ts
const last = environment.store.orm
  .select({ argumentsJson: toolCalls.argumentsJson })
  .from(toolCalls)
  .where(
    and(
      eq(toolCalls.invocationId, environment.context.invocationId),
      eq(toolCalls.toolName, 'send'),
      eq(toolCalls.state, 'success'),
      eq(toolCalls.sideEffect, true),
    ),
  )
  .orderBy(desc(toolCalls.id))
  .limit(1)
  .get();
const previous = last === undefined ? null : auditedSend(last.argumentsJson);
return previous !== null && sendContentKey(previous, resolveStickerRef) === key;
```

贴纸按 ref 解析出的 file id 比对，所以重新 `search_stickers` 拿到新 `stk_` ref 也绕不过去（原有的逐字比对按 ref 比，挡不住这种情况）。原来的 `rejectedSend` 现在也用来解析成功行，所以改名为 `auditedSend`。

在 `deliver` 里，新检查排在逐字比对和 `send_bypass` 之后、Reply 去重之前（`src/capabilities/send-tool.ts:471`）。已被 Reply 去重烧毁的内容仍报 `send_bypass`，旧断言不受影响。新拒绝沿用 `send_duplicate` 错误码，并计入 `DUPLICATE_SEND_REJECTION_LIMIT`；文案单独写成 `SEND_REPEAT_TEXT`，明确告诉模型改换或去掉 `reply_to_message_id` 不会让它变成新消息。带引用目标的这类拒绝行会按已有规则（`wasRejectedByReplyPolicy` 收 `send_duplicate` 行）烧毁内容，接着再换目标就报 `send_bypass`。

### 2. `send_reply` 预检

预检逐条比较：part 1 和本次运行的上一条发送比，之后每个 part 和前一个 part 比：

```ts
const repeatsPrevious =
  index === 0
    ? !leftToDeliver && repeatsLastSend(environment, send)
    : contentKey !== null && contentKey === previousPartKey;
```

`leftToDeliver` 提到循环开头复用：带引用目标的 part 1 沿用原有约定，交给 `deliver` 处理。这样落下的是可烧毁的 `send` 审计行，整组仍然一条都不会发出。

### 3. 重放镜像

`src/orchestration/replay-tools.ts:382` 新增 `checkReplayNotRepeatingPrevious`。它在 `send` 和 `send_reply` 中都排在 `checkReplayNotBypassed` 之后：先拿场景最后一条输出比，再拿前一个 part 比。命中时如果带引用目标、且 Reply 去重开启，就把内容加入 `burnedContentKeys`，和生产一致。

### 4. 文档与文案

手册 `apps/docs/content/docs/configure/telegram.md`、`agent-doc/configuration.md`、`agent-doc/telegram-agent-flow.md`、`agent-doc/verification.md`、`apps/docs/examples/config.example.jsonc`、`src/platform/product-knowledge.ts`，以及 Admin Harness 页中英文 locale 的守卫说明，都同步改为新语义。`send`/`send_reply` 的 Tool 描述也加了一句「改换或省略 reply_to_message_id 重复上一条的内容同样会被拒绝」。

### 5. 测试

- `test/duplicate-send-guard.test.ts`：fixture 多入库一条消息 `11`。新增 6035 复现（先回 `10`、再回 `11` 被拒，去掉引用后报 `send_bypass`；同一贴纸换新 ref 被拒；断言审计行与 `telegram_sends`/`sends_used` 计数）。另新增 `send_reply` 用例，覆盖 part 1 比上一条发送、后续 part 比前一 part、隔一条放行，以及带目标的 part 1 落成 `re-aimed:1` 的 `send` 行。
- `test/replay-tools.test.ts`：新增镜像用例（改投被拒、随后 `send_bypass`、相邻 part 只差 `parse_mode` 被拒）。
- 原本断言「换引用目标或 `parse_mode` 就能连发」的 3 个旧用例（`duplicate-send-guard`、`replay-tools`、`send-bypass-guard` 各一个）改为中间先插一条其他消息，保留原意图。

## 验证

```bash
pnpm exec vitest run test/duplicate-send-guard.test.ts test/replay-tools.test.ts test/send-bypass-guard.test.ts
# 40 passed（加入重放镜像用例前）；之后 replay-tools.test.ts 单独重跑 20 passed
pnpm run check
# tsc --noEmit（runtime/Admin/docs）通过
pnpm run lint
# biome lint + format 通过，无修复
git diff --check
# 通过
pnpm test
# Test Files 115 passed, Tests 1457 passed
pnpm run admin:build && pnpm run admin:test:e2e 19-harness 01-routes
# 23 passed
```

未在真实 Telegram 中复现验证。

## 提交

```txt
38fc917 Reject the previous send's content re-aimed at another reply target
```
