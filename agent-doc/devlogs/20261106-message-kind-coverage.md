# Surowan - 20261106 说清读不懂的消息类型并描述入群事件

## 背景

生产 Invocation `8655`（Chat `-1004392240561`）的 Context 里有 4 条 `kind = 'unsupported'` 的消息，`text`/`caption`/`media` 全是空的，模型只能读到字面量 `[unsupported]`，于是只能回「只能看见『不支持』三个字」。同一 Chat 最近 100 条消息里有 6 条是这种空壳，发送者各不相同。

原因是入库时 `normalizeMessage` 用白名单判定 `kind`：只有 `text`、`rich_message`、`photo`、受支持的图片 `document` 与 `sticker` 有名字，其余一律落到 `unsupported`。`unsupported` 只说明 runtime 用不上，既不告诉面板也不告诉模型来的是视频、投票还是入群事件。入群/邀请这类 Service 消息同样只有 `[service]` 一个占位。

## 主要变更

### 1. `kind` 记录承载内容的 Telegram 字段名

`src/ingress/telegram-ingestion/messages.ts:22` 新增 `CONTENT_KEYS`，`normalizeMessage` 的初值改为 `contentKind(message)`（`src/ingress/telegram-ingestion/messages.ts:303`）：

```ts
let kind = service ? 'service' : contentKind(message);
```

`contentKind`（`src/ingress/telegram-ingestion/messages.ts:411`）返回第一个存在的字段名——`video`、`animation`、`video_note`、`voice`、`audio`、非图片 `document`、`poll`、`dice`、`location`、`contact`、`paid_media`、`story` 等——只有真正未知的字段才退回 `unsupported`。这个字符串同时是面板展示值和 `formatSnapshot` 在空正文时渲染的 `[kind]`，所以两处一起说清楚了。

回复预览的兜底也换成同一个函数（原来对视频回 `[message]`）。图片 `document` 与 `photo` 仍由后续分支写同名 `kind` 并补 Media，行为不变。

### 2. 入群与邀请类 Service 消息带一句描述

`serviceText`（`src/ingress/telegram-ingestion/messages.ts:426`）把 `new_chat_members`、`left_chat_member` 与 `video_chat_participants_invited` 写成正文：

- 被邀请进群：`added Bob to the group`（头部显示邀请者）
- 自行进群：`joined the group`
- 自己退群：`left the group`
- 被移出群：`removed Bob from the group`
- 被邀请加入视频通话：`invited Bob to a video chat`

判断依据是 `message.from` 是否就是事件对象：同一个人就是「自己进/自己退」，否则是邀请者/操作者。显示名经过 `userName` 压成单行，正文照常走 `escapeXml`。

`kind` 保持 `service`，所以参与闸门、启动追赶（`src/orchestration/invocation-queue/catch-up.ts:58`）与主动回复（`src/orchestration/proactive-reply.ts:167`）的 `r.kind <> 'service'` 排除逻辑不变：入群消息仍然不触发 Bucket，只在下一个 Batch 的 Context 里可见。其余未描述的 service 事件继续渲染 `[service]`。

### 3. 文档

`agent-doc/telegram-agent-flow.md:51` 补上 `kind` 取值来源、`[video]` 空体标签与 Service 描述文案，并说明 Service 消息不触发 Bucket。

## 验证

```bash
npx vitest run test/scene/context.test.ts
# 8 passed（新增用例 test/scene/context.test.ts:275 断言 [video] 与三句入群描述）
# 把 src 改动 stash 后同一用例失败：expected ... to contain '[10 ...] Alice\n  [video]'

pnpm test
# 366 files / 1743 tests passed

pnpm run check
# 通过

pnpm run --silent lint
# biome lint + format 无改动
# （本机 `pnpm run lint` 的非静默 reporter 会打印 `ESLint output (JSON parse failed...)` 并退出 1，主 checkout 同样如此，直接跑 biome 退出 0）

git diff --check
# 无输出
```

未执行：真实 Telegram 验收（需要一条真实的视频/投票消息与一次入群事件）。

## 提交

```txt
a71f50f8 Name unreadable message kinds and describe joins
```
