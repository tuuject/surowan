# Surowan - 20261120 按权限列出可用命令的 /help

## 背景

用户要求新增 `/help`：根据请求者拥有的权限，列出他可以使用的 bot command。

改动前没有任何途径让成员知道自己能用哪些命令。Telegram 的 `/` 菜单（`setMyCommands`）对所有人显示全部 12 条命令，管理员专用的几条只在描述里写「（仅管理员）」，非管理员发了会收到「该命令仅对本 Bot 的管理员可用。」。命令的权限分散在三处，彼此没有关联：

- `src/ingress/telegram-ingestion/commands.ts` 的 `BOT_COMMANDS` 菜单与 `COMMAND_NAMES` 解析表。
- `src/orchestration/bot-commands/index.ts` 的 `BotCommandService.run()` 里逐条 `#adminGate(...) ? ... : DENIED_REPLY`。
- `src/ingress/telegram-ingestion/index.ts` 里被 `ignored_user_ids` 命中的成员硬编码放行 `ignoreme` / `unignoreme`。

`/help` 要按权限列命令，就必须和闸门、忽略放行说同一套话，否则会列出实际会被拒绝或被丢弃的命令。

用户在派发前拍板了一项产品决定：已用 `/ignoreme` 忽略自己的成员也可以发 `/help`（原先他们只能发 `/ignoreme`、`/unignoreme` 和 `/ask`）。

本次改动由 Pi（`magpie/auto/deepseek-v4.1-flash`，thinking `max`，T3 子线程「Add /help bot command listing commands by sender permission」）实现，共一轮首次实现加一轮修正。主会话负责任务说明、review、复验与交付。

## 主要变更

### 1. 宿主中立的命令目录

新文件 `src/orchestration/bot-commands/catalog.ts` 是命令的唯一事实来源。每条记录有名字、基础描述、权限档位，以及被忽略成员是否仍能使用：

```ts
export type BotCommandTier = 'anyone' | 'member' | 'admin';

export interface BotCommandCatalogEntry {
  readonly name: BotCommandName;
  readonly description: string;
  readonly tier: BotCommandTier;
  readonly ignoredPassthrough: boolean;
}
```

三档的含义：`anyone` 只要能触达 Bot（`/ask`、`/help`、`/status`），`member` 还要能识别出个人账号（`/whoami`、`/ignoreme`、`/unignoreme`），`admin` 要在宿主的 `admins` 名单里（`/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/allowlist`）。目录不引用 grammY 或任何 Telegram 类型，ingress 引用它，方向与既有分层一致。

由它派生的三处：

- `BOT_COMMANDS` 菜单：管理员命令的描述追加 `ADMIN_DESCRIPTION_SUFFIX`（`（仅管理员）`），既有 12 条菜单文案逐字不变，`/help` 排在 `/ask` 之后。`COMMAND_NAMES` 被删除，解析改用 `isControlCommandName`。
- `BotCommandService.run()`（`src/orchestration/bot-commands/index.ts:89`）在 `switch` 之前统一检查档位，原先逐条的 `#adminGate` 三元式全部去掉；`/whoami`、`/ignoreme` 对无法识别发送者的原有回复不变。
- 忽略放行（`src/ingress/telegram-ingestion/index.ts:151`）改读目录的 `ignoredPassthrough`。`/ask` 不是控制命令，仍走它原有的「实时新消息 + `isAsk`」规则。

### 2. `/help` 的渲染

`src/orchestration/bot-commands/help.ts` 按发送者的访问情况过滤目录，每行一条 `/命令 — 说明`。非管理员只看到自己档位的命令；管理员在空行后多一段「管理员命令：」，`/help` 里的描述不带「（仅管理员）」。

被忽略的成员只看到 ingestion 仍然放行的 `/ask`、`/help`、`/ignoreme`、`/unignoreme`，被忽略的管理员也一样（他的管理命令在 ingestion 就被丢弃了），末尾附一句恢复提示。是否被忽略由 `BotCommandService` 用 `resolveChatConfig(...).ignored_user_ids` 从运行中的配置实时判断。

过滤谓词同时要求档位与忽略放行：

```ts
return catalog.filter(
  (entry) =>
    tierAllows(entry.tier, access.isAdmin, access.identified) && (!access.isIgnored || entry.ignoredPassthrough),
);
```

首轮实现在被忽略时只看 `ignoredPassthrough`、跳过档位检查。按当前目录输出是对的，但以后只要给某条管理员命令打上放行标记，被忽略的非管理员就会看到它而实际被拒绝。修正轮改成上面的写法，并把过滤导出为可注入目录的 `visibleCommands`，回归测试用合成目录覆盖这种情况（修复前输出 `["help", "pause"]`，子 agent 自报已确认先失败后通过）。

`/help` 与其他控制命令一样只写 `telegram_updates` 审计，不写 Message、不建 Bucket；启动追赶只重放 `/pause`、`/resume` 的既有规则不变，因此不会补答。

### 3. 测试

`test/bot-commands/help.test.ts`：管理员、非管理员、无法识别发送者、被忽略成员、被忽略管理员的完整回复；菜单完整列表逐字断言；`/Help@本 Bot 附加文字` 解析、`/help@other_bot` 走普通消息；ingestion 层面 `/help` 不入库、被忽略成员的 `/help` 放行而 `/status`、`/pause` 仍被丢弃、追赶不重放、未加入白名单的 Chat 仍拒绝；以及一条一致性测试：对每个档位，`/help` 列出的每条命令经 `run()` 都不会被拒绝，未列出的管理员命令一律返回拒绝文案。

### 4. 文档

- 用户手册 `apps/docs/content/docs/configure/telegram.md` 新增「查看可用命令」一节，命令表加入 `/help`；被忽略成员仍可发送的命令在该页、`guides/participation.md` 与 `reference/config.md` 中同步加入 `/help`。
- `agent-doc/telegram-agent-flow.md`（菜单注册列表、权限段、忽略放行段）、`agent-doc/configuration.md`（`ignored_user_ids` 放行说明）与 `agent-doc/verification.md`（测试表新增 `help.test.ts` 一行）。
- 没有改 `src/platform/prompts/2-product-knowledge.md`：改动系统 Prompt 分区会改变稳定 Prompt 哈希，触发所有 Conversation Context 重建。

## Review 与处理

ocr（open-code-review）只审了 5 个源码文件（文档与测试被它的默认规则排除），0 条意见。主会话读 diff 发现 5 处，均判为成立，一轮打回：

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| 用户手册「查看可用命令」 | 写了「匿名身份…只列前三条」，但 `parseBotCommand` 丢弃 `from.is_bot` 的消息，匿名管理员与频道身份的 `/help` 根本不会作为命令处理 | 删除该句 |
| 同一节 | 用户手册里出现 ingestion、Bucket、Update 审计等内部术语与设计理由 | 改成用户能观察到的行为 |
| `agent-doc/configuration.md` | 把 `/ask` 说成「查看仍可用的命令」 | 逐条写明各命令用途 |
| `agent-doc/telegram-agent-flow.md` | 放行说明的目的从句只适用于 `/ignoreme`、`/unignoreme` | 同上 |
| `help.ts` 过滤谓词 | 被忽略时跳过档位检查 | 见上文第 2 节 |

保留未改：`registerBotCommands` 的自检在两边都由目录派生后恒成立，无害；`/allowlist` 在未允许 Chat 的放行仍读 `config.telegram.admins` 而服务读 `hostIntakeSettings(...).admins`，属于既有行为，不在本次范围。

## 验证

以下由主会话在该 worktree 里亲自运行（修正轮之后）：

```bash
pnpm run lint
# 通过

pnpm run check
# 通过

pnpm test test/docs/examples.test.ts
# Tests  4 passed (4)

pnpm test test/docs/search.test.ts
# Tests  1 passed (1)

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# 通过

DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 通过；之后 git status --porcelain 只有本次的 12 个文件

git add -A && node scripts/file-token-limit.ts
# 通过

git diff --cached --check
# 通过

pnpm test
# Test Files  458 passed (458)
#       Tests  2303 passed (2303)
```

首轮实现之后另跑过一次快速层：`pnpm run lint`、`pnpm run check`，以及 `pnpm test test/bot-commands test/telegram/ingestion.test.ts test/startup/catch-up.test.ts` 连续 3 轮，各 11 files / 85 tests 通过。

base 提交 `110c342f` 上的全量基线：主 checkout 快进后 `packages/image-service` 与 `packages/admin-surface` 的 `dist` 未重建，导致 13 个文件失败；重建 dist 后这些文件全部通过，base 上没有已知失败。

只由子 agent 自报、主会话没有单独重跑：修正轮回归测试「修复前失败、修复后通过」。

未执行：

- 真实 Telegram 群里的 `/help` 验收（管理员、普通成员、被忽略成员三种身份），以及 `setMyCommands` 注册后客户端菜单的实际显示。
- Admin Panel e2e：本次没有改面板前端、admin API 或面板文案。

## 提交

```txt
5dd9168a Add a permission-aware /help bot command
```
