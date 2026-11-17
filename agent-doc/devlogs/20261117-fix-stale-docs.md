# Surowan - 20261117 文档防腐：修正与源码不符的入口、主题与用户文档

## 背景

一次全仓审计把文档逐条与源码对账，发现入口文档 `AGENTS.md` 自相矛盾、几篇主题文档引用了目录重组之后已经不存在的文件与符号，用户文档里也有两处与代码不符。这些都是「文档陈旧」而不是代码缺陷，所以本次只改 Markdown，不动任何代码。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-b-docs-v1`）实现，主会话逐条对照源码复核。

## 主要变更

### 1. `AGENTS.md`

- 「Architecture Overview」末尾仍写着「记忆按 Conversation 隔离，由模型通过 `add_memory`/`delete_memory` 能力维护」。这是被 Memo Pad 取代的旧记忆系统：`delete_memory` 在源码里不存在，同一文件的 Project Goals 已经正确描述 Memo Pad「按 Chat 隔离、Topic 共用」。删掉这句，不再自相矛盾。
- canonical history 唯一写者的路径 `src/context/store.ts` 改为 `src/context/store/index.ts`。
- 能力注册表的位置改为 `src/adapters/local-monolith/host-tooling.ts` 的 `createHostTooling`（组装 `capabilityTools`，经 `runtime/serve.ts` 注入），原文指向的 `runtime/index.ts` 并不构建它。
- 目录树补上 `src/runtime-catch-up.ts`、`plugins/web-search/` 与 `packages/cli/`；`scripts/` 不再描述成「一次性维护脚本」，它同时放着 `audit/`、`docs/`、`manual-prepare` 等常驻工具。

### 2. `agent-doc/telegram-agent-flow.md` 的 typing 段落

被 @ 时自动显示 typing 的那段引用了 `MentionTyping.start`、`src/capabilities/mention-typing.ts`、`startTypingLoop` 与 `grammySendApi`，这四个名字都已不存在。按现状重写：`runtime/serve-run.ts` 的 `onUpdate` 调用 `telegramHost.activity.start(target, 'until_delivery')`，接口在 `src/platform/im-host/`，Telegram 实现在 `src/adapters/local-monolith/telegram/host.ts`。保留并核实了仍然成立的行为：4 秒刷新、55 秒上限、每个 Chat + Topic 至多一轮、模型调用 `typing` 时以 `until_stop` 接管 `until_delivery` 轮、成功发布即停止、`telegram.mention_typing_enabled` 关闭时 ingest 不返回 `mention`。

### 3. 路径与标识符

- `agent-doc/configuration.md`、`agent-doc/architecture.md`：`src/platform/config-schema*.ts` 改为 `src/platform/config/` 下的 `schema.ts`、`schema-model.ts`、`schema-sections.ts`；`adapters/local-monolith/config*.ts` 改为 `adapters/local-monolith/config/`。
- `agent-doc/admin-panel.md`：前端文件表里的 `src/lib/search-params.ts`（不存在）改为 `src/lib/list-query.ts` 及其实际导出；组件清单的 `PrivateReasoning` 改为 `PrivateReasoningTag`；`e2e/33-i18n-stress.e2e.ts` 改为拆分后的 `e2e/33-i18n-stress-*.e2e.ts`，并把「遍历全部一级路由」改成 helper 里实际使用的代表性路由集合。
- `apps/admin-next/README.md`：删除不存在的 `PrivateReasoningNote()` 条目。

### 4. 用户文档

- `apps/docs/content/docs/operations/backup-restore.md` 与 `guides/images.md`：图片快照目录写成了 `surowan-….sqlite.images/`。`snapshotImageDirectory` 是把备份文件名的 `.sqlite` 后缀替换成 `.images`，实际目录名是 `surowan-….images/`。同时去掉「启用了图片生成时」这个不存在的前提（只要 `<data_dir>/images` 存在就会拷贝），恢复清单补上把 `.images` 放回 `data_dir/images` 的一步。
- `apps/docs/content/docs/configure/admin.md`：新增一段说明密码登录的失败锁定（10 次失败锁 15 分钟）按 TCP 对端地址计数，这是有意的（转发头可以伪造）；代价是放在反向代理后面时所有访客共享一个计数，任何人失败 10 次都会锁住管理员的密码登录。Passkey 与一次性码登录不走这条计数。

### 5. review 中修正的一处

首轮实现把 Contexts 加进了「通过 URL `chat` 参数管理 Chat 范围」的页面列表并写成「八个页面」，但同一句后半仍说「其余六个页面」，而且 Contexts 并不在 Chats 页的跳转菜单里（`components/chats/chat-table.tsx` 只有七个目标）。主会话改为「七个页面（以及 Contexts 与 Recurring alarms 两页，它们不在 Chats 页的跳转菜单里）」。

## 验证

主会话亲自运行（在子 agent 的 checkout 内）：

```bash
git diff --check && pnpm run lint && pnpm run check
# 全部通过

pnpm test test/docs test/manual-pack.test.ts
# 5 files / 27 tests passed

DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
# Verified 53 HTML/Markdown pages, search, examples, schema, provenance and 173 HTTP resources (base /).
DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# Verified 53 HTML/Markdown pages, search, examples, schema, provenance and 173 HTTP resources (base /surowan/).

git status --porcelain
# 只有本次修改的 9 个 Markdown 文件
```

在 Git Bash 下 `DOCS_BASE_PATH=/` 会被 MSYS 自动转换成 Windows 路径，导致 `scripts/docs/prepare.ts` 拒绝；需要先 `export MSYS2_ENV_CONV_EXCL=DOCS_BASE_PATH`。

未执行：

- 全量 `pnpm test` 与面板 e2e：本次只改 Markdown，未跑。
- AI review（ocr）对这批改动没有产出：它不选取 Markdown 文件。所有条目由主会话逐条对照源码人工复核（typing 语义对照 `telegram/host.ts`，锁定参数对照 `ingress/admin/auth.ts` 与 `passkeys.ts`，跳转菜单对照 `chat-table.tsx`）。

## 提交

```txt
5bf01da8 Fix stale and contradictory agent and user docs
```
