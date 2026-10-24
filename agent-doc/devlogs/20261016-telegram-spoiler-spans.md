# Surowan - 20261016 Telegram spoiler 进入 Agent 上下文

## 背景

Telegram 的 spoiler（剧透折叠）是一种 `MessageEntity`，覆盖消息正文（`text`，媒体消息则是 `caption`）的一段。`normalizeMessage` 只把正文存进 Revision，entity 全部丢弃，所以发送者主动折叠的内容在模型眼里和普通文字一样，模型可能直接引用、展开或放大它。

已有条件和约束：

- Revision 的 `raw_fragment_json` 原样保存了整条 Telegram 消息，entity 与 `reply_to_message` 都还在，不需要新增列或迁移。
- 没有 spoiler 的消息，快照必须和改动前逐字节一致。
- spoiler 只是社交语义，不是机密边界：只要让模型知道「这段是 spoiler」，不需要遮挡；用户自己打出的字面 `<tg-spoiler>` 也不转义。

本次分两个提交完成：第一个提交覆盖正文与 caption；随后的代码评审（open-code-review）发现回复引用行和 replay 场景仍会漏标，第二个提交补上了这两处。

## 主要变更

### 1. 从 raw fragment 还原 spoiler 区间

[src/platform/spoilers.ts:61](../../src/platform/spoilers.ts#L61) 的 `spoilersFromFragment` 解析 `raw_fragment_json`，按 `text`/`caption`/`reply` 分组返回区间：

- `text` 用 `entities`、`caption` 用 `caption_entities`，且只在 fragment 的正文与 Revision 一致时采信，避免编辑后偏移错位。
- 偏移是 UTF-16 code unit，与 Telegram 报告的单位、JavaScript 字符串索引一致，`body.slice(start, end)` 就是 spoiler 文本，不做码点换算；emoji 和中文之后依然对齐。
- [spoilerRanges](../../src/platform/spoilers.ts#L117) 丢弃非 spoiler、坏掉、越界或空的 entity；[normalizeSpoilerRanges](../../src/platform/spoilers.ts#L135) 排序、裁剪并合并重叠区间，所以渲染出的标签始终成对。
- fragment 读不了或对不上时返回 `undefined`，不让展示层的丢失影响 Invocation。

[src/store/invocation-snapshot.ts:138](../../src/store/invocation-snapshot.ts#L138) 建快照时调用它，只在有 spoiler 时写入 `spoilers` 字段（[:157](../../src/store/invocation-snapshot.ts#L157)）：

```ts
const replySnapshot: unknown = message.reply_snapshot_json === null ? null : JSON.parse(message.reply_snapshot_json);
const spoilers = spoilersFromFragment(message.raw_fragment_json, {
  text: message.text,
  caption: message.caption,
  reply_snapshot: replySnapshot,
});
```

因为数据来自本来就存着的 fragment，落库更早的历史消息进入新快照时也会带上标记。

### 2. 渲染成 `<tg-spoiler>` 标签

`MessageSnapshotSchema` 增加可选的严格对象 `spoilers`（[src/context/context-builder.ts:60](../../src/context/context-builder.ts#L60)）。`formatSnapshot` 用 [renderSpoilers](../../src/platform/spoilers.ts#L159) 把每个区间包成 `<tg-spoiler>…</tg-spoiler>`，正文原样保留，不删除、不占位（[src/context/context-builder.ts:760](../../src/context/context-builder.ts#L760)）。

`CORE_AGENT_PROTOCOL` 加了一句说明：标签内是发送者主动折叠的内容，可以读，但应当作剧透、玩笑或不成熟的看法，而不是机密；除非当前任务就是关于它，否则不要引用、展开或点出别人的 spoiler。`AGENT_PROMPT_VERSION` 从 `8n` 升到 `9n`（[src/platform/agent-protocol.ts:1](../../src/platform/agent-protocol.ts#L1)），system prompt 哈希随之变化，各 Conversation Context 会在下次运行时重建。

### 3. 回复引用行

`compactReply` 把被回复消息的正文截到 500 个 code unit 存进 `reply_snapshot.content`，entity 被丢掉。被回复的消息不在本批时，`formatSnapshot` 会输出 `> sender: content` 引用行，spoiler 文本就以明文出现。

[replySpoilers](../../src/platform/spoilers.ts#L94) 从 fragment 的 `reply_to_message` 取 entity（有 `text` 用 `entities`，否则用 `caption_entities`，与 `compactReply` 的 `text ?? caption` 对应）：

- 只在 `content` 仍是被回复正文的前缀时采信，用前缀判断代替复制 500 这个截断长度。
- 区间按 `content.length` 裁剪。
- 被回复者在 `ignored_user_ids` 中时没有 `reply_snapshot`，也就没有区间。

引用行渲染见 [src/context/context-builder.ts:749](../../src/context/context-builder.ts#L749)：

```ts
body.push(`> ${singleLine(reply.sender)}: ${singleLine(renderSpoilers(reply.content, snapshot.spoilers?.reply))}`);
```

`reply_snapshot` 本身原样保存，区间放在 `spoilers.reply`。

### 4. replay 场景与线上一致

`src/context/scene-context.ts` 为 replay 自己构造 `PreparedSnapshot`，原来两条路径都会丢掉标记：

- 开场批次 `loadOpeningBatch` 重新组对象时没带上冻结快照里的 `spoilers`，现在透传（[:426](../../src/context/scene-context.ts#L426)）。
- 没有冻结快照时，历史从 Revision 行回退重建。`HistoryRow` 新增 `raw_fragment_json`，`loadHistoryWindow` 与 `loadSliceBatch` 的查询都选出这一列（[:463](../../src/context/scene-context.ts#L463)、[:686](../../src/context/scene-context.ts#L686)），回退路径用同一个 `spoilersFromFragment` 还原（[:574](../../src/context/scene-context.ts#L574)）。

带冻结快照的历史本来就用 `...parsed` 整体展开，不需要改。

### 5. 文档

- `agent-doc/telegram-agent-flow.md` 的注入段说明新增 Spoiler 条目，包括引用行和 replay 路径。
- `agent-doc/verification.md` 的目标测试命令加入 `telegram-spoiler.test.ts`，测试表新增该行，并补充 `scene-context.test.ts` 的覆盖说明。

## 验证

新增 `test/telegram-spoiler.test.ts`，覆盖：无 spoiler 的消息提示不变；整条、部分、多条 spoiler；emoji 与中文之后的 UTF-16 偏移；媒体 caption；与其他 entity 并存；正文与 `raw_fragment_json` 原样保存；保留历史中的标签；无 spoiler 时快照不新增字段；回复引用行（含截断、caption、前缀不一致、引用为空）。`test/scene-context.test.ts` 新增一例，覆盖 replay 的开场批次、回退历史与引用行。`test/scheduler.test.ts` 的 prompt 版本断言改为 `9n`。

为确认第二个提交的测试确实复现了原故障，把 `scene-context.ts`、`context-builder.ts`、`invocation-snapshot.ts` 临时换回第一个提交的版本再跑：

```bash
pnpm test test/scene-context.test.ts test/telegram-spoiler.test.ts
# 修复前：Tests  2 failed | 37 passed (39)
#   × renders spoiler markup like production in the opening batch, fallback history and reply quotes
#   × marks a spoiler inside the quoted preview of an outside reply target
# 修复后：Tests  39 passed (39)
```

最终验证：

```bash
pnpm run check
# 通过
pnpm run lint
# Checked 472 files. No fixes applied.（lint:fix 先修复了两处格式）
pnpm test
# Test Files  105 passed (105)
#      Tests  1352 passed (1352)
git diff --check
# 无输出
```

未运行：真实 Telegram 人工验收（发送 spoiler 文本、带 spoiler 配文的图片、回复较早的 spoiler 消息，并在 Admin Panel 检查渲染出的 Context），以及新协议句子对模型实际行为的观察。

## 提交

```txt
e7f1873 Preserve Telegram spoiler spans in the agent context
a53b182 Mark spoilers in reply quotes and replay scenes
```
