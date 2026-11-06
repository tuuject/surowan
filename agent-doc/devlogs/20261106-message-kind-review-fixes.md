# Surowan - 20261106 消息类型改动的 review 修复：service 头部标记与忽略成员

## 背景

PR #63（`a71f50f8 Name unreadable message kinds and describe joins`）让入群、退群、邀请视频通话这几种 Service 消息由 runtime 写一句英文描述，存进 `text`。PR review（open-code-review 加人工核对下游代码）发现 3 个 medium 和 1 个 low 问题：

1. **混合入群丢成员**：`serviceText` 用 `joined.some((member) => member.id === actor.id)` 判断自行入群。只要发送者在 `new_chat_members` 里，整条就写成 `joined the group`，同一条消息里的其他新成员全部丢失。
2. **被忽略成员泄露**：`ignored_user_ids` 只按 `message.from` 过滤。Alice 拉进或踢出被忽略的 Bob 时，正文会写 `added Bob to the group`，Bob 的显示名就进了 Context。这和 `agent-doc/configuration.md` 的约定冲突：被忽略用户的消息不入库，指向他们的 Reply 快照也不保存。
3. **runtime 文本与成员文本无法区分**：描述写在发送者正文的位置，成员自己打一句 `added Bob to the group`，渲染结果完全一样。群聊记忆整理的 prompt 要求「ignore service messages」，但 `renderGroupTranscript` 现在把这类事件当普通正文显示，整理模型认不出来。
4. **low**：grammY 5.0.0 的 `Message` 已有 `checklist` 字段，`CONTENT_KEYS` 没收录，清单消息还是 `[unsupported]`。`Record<string, true>` 也不做编译期检查，键名拼错只会悄悄落到 `unsupported`。

## 主要变更

### 1. 头部加 `service` token

正文区是 Telegram 可控内容，模型只信任头部方括号里的 runtime token。所以标记加在头部，不加在正文里（正文前缀成员也能打出来）。`src/context/builder/format.ts:23`：

```ts
if (snapshot.kind === 'service') {
  tokens.push('service');
}
```

渲染结果：`[11 00:00:05 service uid:42 @alice] Alice` 下一行缩进 `added Bob to the group`。`collectVisibleSenders` 这类头部回读函数按空格拆 token、按前缀匹配，多一个 token 不受影响。

群聊记忆的 transcript 同样标记（`src/context/group-memory/messages.ts:160`），头部写成 `[5001 service] Bob`。整理 prompt 改成「service messages (headers marked service)」（`src/context/group-memory/consolidate.ts:33`）。

核心协议 `src/platform/prompts/1-core-protocol.md:10` 的头部说明补了一句：`a header marked service is an event Telegram reported (such as a member joining or leaving), whose content the runtime wrote rather than the sender.`。system prompt 哈希会因此变化，所有 Conversation Context 下次运行时都会重置。

### 2. 入群描述的形状与忽略名单

`serviceText` 现在接收 `ignoredUserIds`（`src/ingress/telegram-ingestion/messages.ts:436`）：

- 只有「唯一新成员就是发送者」才写 `joined the group`（`:443`）。其余情况把所有新成员列进 `added … to the group`，例如 `added Alice and Carol to the group`。
- `added`、`removed`、`invited … to a video chat` 都先滤掉忽略名单里的成员；滤完为空就返回 `null`，正文渲染 `[service]`（`:454`）。被忽略成员自己的进群、退群消息本来就在入口被 `isIgnoredUser` 整条丢弃。

### 3. `CONTENT_KEYS` 补全并做类型约束

补上 `checklist` 与 `passport_data`，对象改成 `satisfies Partial<Record<keyof Message, true>>`（`src/ingress/telegram-ingestion/messages.ts:24`、`:56`），键名拼错会在 `tsc` 报错。注释改为说明顺序的作用：Telegram 为了兼容，会在 animation 旁边同时设 document、在 venue 旁边同时设 location，所以取第一个匹配的字段。

### 4. 文档

`agent-doc/telegram-agent-flow.md` 补充了：头部格式里的 `service` token、单人自行入群的判定规则、忽略成员的处理方式，以及标记加在头部的原因。

## 验证

```bash
npx vitest run test/scene/context.test.ts test/group-memory
# 7 files / 34 tests passed
# 新增/改写用例：test/scene/context.test.ts:275（[checklist]、混合入群、成员手打的 joined the group 不带 service）
#               test/scene/context.test.ts:314（忽略成员：渲染与 message_revisions.text 落盘均不含 Bob）
#               test/group-memory/tools.test.ts:153（read_group_messages 头部 [5001 service]，审计 success）
# 撤掉 src 改动后同一批用例 3 个失败（缺 [checklist]、缺 service token），补回后通过

pnpm test
# 366 files / 1745 tests passed

pnpm run check
# 通过

./node_modules/.bin/biome lint . && ./node_modules/.bin/biome format .
# 退出 0，无改动
# （`pnpm run lint` 的非静默 reporter 仍打印 `ESLint output (JSON parse failed...)` 并退出 1，与上一篇 devlog 记录的本机现象相同）

git diff --check
# 无输出
```

未执行：真实 Telegram 验收（混合入群、拉入/踢出被忽略成员、清单消息各一条），以及核心协议改动后真实模型对 `service` token 的理解。

## 提交

```txt
c09cf5a7 Mark service events in headers and hide ignored members
```
