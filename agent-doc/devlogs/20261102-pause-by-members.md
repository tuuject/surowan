# Surowan - 20261102 按群把 `/pause` 开放给所有成员

## 背景

`/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/allowlist` 一直共用同一个闸门：发送者必须在 `telegram.admins` 里。这对管理类命令是对的，但对 `/pause` 偏严——群里刷屏时想立刻让 Bot 安静，却要先找一个管理员。

需求是把暂停这一件事按群下放：某个群打开开关后，任何成员都能用 `/pause`；`/resume` 保持原样，仍然只对机器人管理员开放。也就是「成员能让它闭嘴，只有管理员能让它重新开口」。这个不对称是刻意的：如果 `/resume` 也一起开放，群成员可以随意把被管理员停掉的群重新打开，暂停就失去了治理含义。

## 主要变更

### 1. 新的按群配置字段

`ChatSchema` 新增可选布尔 `pause_by_members`：

```jsonc
{
  "id": -1001234567890,
  "pause_by_members": true
}
```

- **缺省即关闭**：字段不存在与 `false` 等价，都表示仅 `telegram.admins` 可暂停，旧配置不需要任何迁移。
- **私聊拒绝**：`src/platform/config/semantics.ts` 对 `chat.id > 0` 且声明该字段的配置直接报错（`is a private chat and cannot open /pause to members`）。私聊只有一个成员，开放后只可能让非管理员锁住一个自己解不开的会话，没有使用场景。
- **热更新**：`src/platform/config/diff-merge.ts` 增加 `HOT_PAUSE_BY_MEMBERS_PATHS`（`/^telegram\.chats\[-?\d+\]\.pause_by_members$/`）。判定在每次命令执行时读运行中的配置，因此开关打开或关闭都不需要重启，也不会让已存在的 `chat_pause` 行失效。

### 2. 命令闸门

`BotCommandService` 的 `case 'pause'` 从 `#adminGate(sender)` 改为 `#pauseAllowed(telegramChatId, sender)`：

```ts
#pauseAllowed(telegramChatId: bigint, sender: CommandSender | null): boolean {
  if (sender === null) {
    return false;
  }
  return this.#adminGate(sender) || this.#chatConfig(telegramChatId)?.pause_by_members === true;
}
```

- 管理员依旧无条件通过，所以开关关闭时行为与之前完全一致。
- `sender === null`（`message.from` 缺失或 `sender_chat` 匿名身份）一律拒绝，与其它命令共用同一条规则：频道身份发言和匿名管理员不能代表任何人暂停一个群。
- `#chatConfig` 走 `resolveChatConfig`，沿用已有规则：群迁移时按迁移前的 Chat 条目解析配置。
- `case 'resume'` 没有改动，仍然直接走 `#adminGate`。

`BOT_COMMANDS` 里 `/pause` 的菜单描述改成「暂停本群互动（默认仅管理员）」。`setMyCommands` 注册的是全局菜单，无法表达「某个群开放、另一个群没开放」，所以描述只能退到最保守的说法；实际判定始终按群进行。

### 3. Admin 面板

新增写端点 `PUT /api/chats/:id/pause-policy`，body 只接受 `{ pause_by_members: boolean }`：

- 关闭时写入 `undefined` 删除该键，而不是留一个显式的 `false`，这样「没有配置」和「明确关闭」不会在文件里积累成两种状态。
- 私聊返回 400 `invalid_body`，未知 Chat 返回 404 `chat_not_found`，重复保存相同值不写文件，热应用。
- 沿用其它 Chat 写端点的 `If-Match` revision、8 KiB 请求体上限与完整 Chats 视图响应。

Chats 视图的 `saved` / `active` 增加 `pause_by_members`（缺省渲染为 `false`，不返回 `null`，前端不需要区分「未配置」与「关闭」）。

前端在 Chats 页新增「暂停命令」列（摘要为「所有成员」/「仅 Bot 管理员」）与盾牌按钮，弹窗 `pause-policy-dialog.tsx` 只有一个开关加一句「`/resume` 不会开放」的说明。列和按钮都只对群聊（ID 以 `-` 开头）渲染，和活跃时间、主动回复、群聊记忆保持一致。

### 4. 拆分 `src/ingress/admin/chats.ts`

加上这一节后 `chats.ts` 会到 20,817 字节，超过 pre-commit 钩子的 20,000 字节（5,000 tokens）上限。按职责拆成两个文件：

- `src/ingress/admin/chat-feature-edits.ts`：`participation`、`proactive_reply`、`group_memory`、`pause_by_members` 四种「只改 Chat 某一个嵌套节」的写入，含各自的 body schema、`parseXxx` 与 `updateChatXxx`。这几者形状相同，都是读当前值、比对、生成单条 `ConfigEdit`。
- `src/ingress/admin/chats.ts`：allowlist 增删、模型覆盖、数据清理与列表视图，并向兄弟模块导出 `fileChats` / `chatIndex`。

拆完 `chats.ts` 12,913 字节、新文件 8,586 字节；路由 `src/ingress/admin/routes/chats.ts` 改从新模块导入，端点路径与行为不变。

### 5. 测试与文档

- `test/bot-commands/service-admin.test.ts` 新增群聊用例：匿名身份在开关打开时仍被拒；普通成员能暂停；该成员 `/resume` 仍被拒且 `chat_pause` 行还在；管理员 `/resume` 才真正清掉。配套在 `test/bot-commands/fixtures.ts` 加了 `groupTextUpdate`（supergroup 消息，用来先落一条 Chat 行）。
- `test/admin/chats-pause-policy.test.ts` 覆盖热应用、`applied` 路径、重复保存不写文件、关闭后文件里不再出现该键，以及私聊 / 非法 body / 未知 Chat / 405 / 过期 revision。
- `test/config/diff-telegram.test.ts` 验证打开与关闭两个方向都是 `hot`、关闭时从 candidate 里删除该键。
- `test/foundation/configuration-contract.test.ts` 验证私聊声明被拒、非布尔被 schema 拒、群聊可正常加载。
- `apps/admin-next/e2e/09-chats-pause-policy.e2e.ts` 走真实面板：读列、开开关、刷新视图断言 `saved.pause_by_members`、再关掉、最后删除该 Chat。
- 文档同步 `agent-doc/configuration.md`（热更新表、Chat 字段、重启枚举、admins 语义）、`telegram-agent-flow.md`（命令权限段与 `setMyCommands` 描述）、`admin-panel.md`（端点表与 Chats 页说明），以及 `apps/docs` 的 `configure/telegram.md`、`reference/config.md`、`configure/admin.md`。

## 验证

```bash
pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm test
# 353 test files passed（1966 passed / 2 skipped）

pnpm run admin:build
pnpm exec playwright test e2e/09-chats-pause-policy.e2e.ts
# 1 passed

pnpm exec playwright test e2e/09-chats.e2e.ts e2e/09-chats-active-hours.e2e.ts \
  e2e/09-chats-group-memory.e2e.ts e2e/09-chats-proactive-reply.e2e.ts
# 11 passed

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, search, examples, schema, provenance and 116 HTTP resources

biome lint / biome format（改动文件）
# 无报告
```

未执行：真实 Telegram 群里用非管理员账号发 `/pause` 的人工验收。

## 已知限制

- 只覆盖 `/pause`。`/resume` 的闸门没有变化，成员暂停后必须等管理员恢复，这是设计取舍而不是遗漏。
- Telegram 命令菜单是全局的，`/pause` 的描述只能写「默认仅管理员」，无法按群显示真实权限。
- 私聊不能配置该字段，也不能通过面板打开。
- 匿名身份（频道身份发言、匿名管理员）即使开关打开也仍然被拒。
- 开关只影响之后的命令，不会改变已有的 `chat_pause` 状态：打开开关不会自动恢复一个已暂停的群，需要管理员手动 `/resume`。

## 提交

```txt
92cbe4a Let a Chat open /pause to its members
```
