# Surowan - 20261018 Reply 判重反绕行：被拒内容在本次运行内烧毁

## 背景

线上 Invocation 5962（`openai/gpt-6-luna`）：模型回复消息 38907 成功（38909）后，又把同一话题的第二种说法发给 38907，被 Reply 去重以 `reply_already_sent` 拒绝；下一回合它把**同一段文本**改投给 38908，成功发出（38910）——正是拒绝文案里「Do not omit or change reply_to_message_id to bypass」明确要求不要做的事，但当时没有任何机制强制执行。随后模型又重试 4 次（`send_duplicate` ×2、`reply_already_sent` ×2，换着签名来，绕开了「连续同签名失败」熔断），8 轮里 5 轮白费。

两个洞：

1. **绕行不违约**：`reply_already_sent` 按「目标消息」判重，被拒内容换个 `reply_to_message_id` 就变成一次「新」发送；拒后劝阻只能靠模型自觉。
2. **交错失败逃出熔断**：`repeated_tool_failure` 要求连续整轮同签名失败，交替换目标/换内容的死磕永远不会同签名。

本次只堵第一个洞（烧毁被拒内容）；交错式死磕的 token 浪费仍有 `turns_per_injection` 与发送限流兜底，按「拒绝预算」提前收口留作后续改进。

## 主要变更

### 1. 拒后内容烧毁（`send_bypass`）

`src/capabilities/send-tool.ts`：

- 新内容键 `sendContentKey`（`src/capabilities/send-tool.ts:981`）：kind + 文本（text）或 kind + 贴纸 ref 解析出的 sticker file id（sticker，见第 6 节），**不含** `reply_to_message_id` 与 `parse_mode`。图片返回 `null` 继续豁免——理由同重复发送守卫：被拒的尝试什么都没交付，generation 之后还可能增加成品。
- `wasRejectedByReplyPolicy`（`src/capabilities/send-tool.ts:1005`）：查本 Invocation 的 `tool_calls` 里 `tool_name = send`、`state = error`、`error_code ∈ {reply_already_sent, reply_delivery_unknown}` 的行。拒绝行留存的是模型**原始输入**（5962 里那种塞满 `sticker_ref: "x"`、全零 UUID 占位字段的形状），所以逐行重新 `narrowSendInput` 归一化后比对内容键；《发送失败可重试》的规则不变——被烧毁的只有 Reply 策略拒绝，send 屏障（明确邀请读完新批次再发）与限流（窗口会滑）拒绝都不烧。
- `deliver` 在已发布判重（`send_duplicate`）之后、Reply 去重之前检查：命中即记 `send_bypass` 错误审计并抛「这段内容已被 Reply 策略拒过，换或省 reply_to 都不能再发；写点新的，或别再调用 send」。不调用 Telegram、不写 `telegram_sends`、不占 `sends_used`。
- `send_reply` 预检在逐条查重之后同样逐条查烧毁，命中整组不发；交付中途被 Reply 拒的 part（`tool_call_id = <id>:<n>`，按 `send` 记账）内容同样被烧毁，之后的单独 `send` 不能再发它。
- 烧毁范围是 Invocation（`invocationId` 限定）：跨运行不继承——新一批消息驱动的新 Invocation 可以说同样的话，而 Reply 去重本身随发送审计跨 Invocation 存续。「图片豁免」之外还有一个有意的不对称：烧毁只管**被拒**过的内容，已成功发送的内容换个 Reply 目标重发仍按「不同目标 = 不同消息」的既有契约放行（那是 `send_duplicate` 的语义边界，不在本次范围）；但原样重发一条已发出的 Reply 被 `send_duplicate` 拦下后，该内容同样烧毁（见第 6 节）。

### 2. 与重复发送守卫的关系

烧毁是 Reply 去重的执行面，**不依赖** `send_duplicate_guard_enabled`：守卫关闭时 `send_bypass` 依然拦截（没有 Reply 去重产生拒绝行时才无从烧起）。但每次 `send_bypass` 在守卫开启时仍走 `duplicateSendGuard.onRejected()` 计数，与其他拒绝一起受 `DUPLICATE_SEND_REJECTION_LIMIT` + `duplicate_send` 停止约束；守卫关闭时只拦截不计数。

`send`/`send_reply` 的 Tool 描述随之更新：单回复策略的末句从「不要删掉或改换目标来绕过被拒的重复」改为「被拒后删掉或改换目标不会解除拒绝」——从劝诫变成事实陈述。

### 3. 重放对齐

`src/orchestration/replay-tools.ts`：`ReplayState` 新增 `burnedContentKeys`；`checkReplayReplyUnused` 拒绝时把该场景发送的内容键烧入，`checkReplayNotBypassed` 在 `checkReplayNotDuplicate` 之后、Reply 检查之前比对，命中抛场景版 `send_bypass`，并同样回调 `duplicateSendGuard?.onRejected()`。`send_reply` 预检走同一函数。内容键直接复用 `send-tool.ts` 导出的 `sendContentKey`，不与生产产生第二套键规则。

### 4. 测试

- 新增 `test/send-bypass-guard.test.ts`（9 条）：被拒文本换目标/省目标/换 `parse_mode` 都是 `send_bypass`（含 5962 同款占位字段的原始输入归一化比对）、新内容不受影响、拒绝不占额度且回调计数；贴纸同规则；`reply_delivery_unknown` 同样烧毁；屏障拒绝不烧毁、放行后可原样发出；`send_reply` 预检命中烧毁整组不发、part 交付中途被拒内容同样烧毁；图片豁免；重复发送守卫关闭时烧毁仍生效；烧毁跨 Invocation 失效而 Reply 去重持续。
- `test/replay-tools.test.ts`：场景内「Reply 拒绝 → 换目标/裸发/send_reply 均为 `send_bypass` → 新内容可发」，计数与 dispatch 形状一并断言。

### 5. 文档

`agent-doc/telegram-agent-flow.md`（send Tool 小节的烧毁语义、键定义、豁免与计数关系、重放沿用）、`agent-doc/configuration.md`（`allow_reply_message_multiple_times` 条目补烧毁）、`agent-doc/verification.md`（测试命令组与矩阵）、用户指南 `apps/docs/content/docs/configure/telegram.md`（绕行拦截的一节）。

### 6. Review 跟进：重复拒绝漏烧与贴纸重搜绕行

PR review 指出两条仍能真实发出的绕行，已在后续提交修复：

- **原样重发已发出的 Reply 没烧**：`deliver` 先查 `send_duplicate` 再查烧毁，原样重发 `{A, reply_to:42}` 被判重复（不是 Reply 策略错误码），`A` 没烧；随后省掉目标的 `{A}` 判重键不同、无烧毁行、无目标跳过 Reply 去重，`A` 被二次发布。现在 Reply 去重开启时，带 Reply 目标的 `send_duplicate` 拒绝行也算烧毁证据——原样重复一条成功 Reply 必然指向已回复消息，只是重复守卫先答了。`send_reply` 预检对「带目标的 part 1 精确重复」不再自行拦截，交给 `deliver` 落成可烧毁的 `send` 审计行（part 1 最先发送，整组仍不发出任何消息，守卫计数只记一次）。`allow_reply_message_multiple_times: true` 时不烧。重放的 `checkReplayNotDuplicate` 同步。
- **贴纸按 ref 烧毁可被重搜绕开**：`context-refs.stickerRef` 每次 `search_stickers` 都生成新的随机 `stk_` ref，同一张贴纸重搜即换键。`sendContentKey` 改为接收 ref 解析器，按解析出的 sticker file id 取键；拒绝行的 ref 解析不了（已过期）就无键、不匹配。重放场景不运行贴纸搜索、不会给同一贴纸产生第二个 ref，传恒等解析器即可。

`test/duplicate-send-guard.test.ts` 的首条用例原本恰好按「回复 → 原样重发被拒 → 省目标重发成功」的顺序书写，即第一条绕行；改为先验证「不同目标/`parse_mode` 是不同消息」，再验证原样重发被拒，契约意图不变。新增回归：`send-bypass-guard.test.ts` 4 条（重搜贴纸仍烧、原样重发 Reply 烧、`send_reply` part 1 原样重发烧、允许多次回复时不烧），`replay-tools.test.ts` 1 条场景镜像；前 3 条与重放用例在修复前的源码上失败。

## 验证

```bash
pnpm test
# Test Files  112 passed (112)
# Tests  1417 passed (1417)

pnpm run check          # 通过
pnpm run lint           # lint:fix 重排了 2 个测试文件后通过
pnpm run docs:build && pnpm run docs:verify   # 通过（23 页 / 83 资源）
```

第 6 节跟进：受影响的 6 个测试文件 92 条通过，`pnpm run check`、`pnpm run lint`、`git diff --check` 通过；完整 `pnpm test` 仅 `context-hot-inject.test.ts` 一条 typing 时序用例失败，单独重跑该文件 33 条全过，判定为与本改动无关的时序抖动。

未覆盖：没有在真实 Telegram 或真实模型上验收；交错式死磕的提前收口（拒绝预算）未实现。部署后可观察 `error_code = send_bypass` 的 Tool Call 是否出现、以及 5962 形状的 Invocation 是否提前于「词穷自然停」收敛。admin E2E 未重跑（本次无 Admin 界面改动）。

## 提交

```txt
e3ad4ed Enforce the reply-policy no-bypass rule within an invocation
ee3f29a Burn repeated replies and key sticker burns on the file
```
