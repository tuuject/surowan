# Surowan - 20261113 贴纸集管理：Telegram 分组、热更新、改昵称与模型可见的备注

## 背景

Admin Panel 的「Bot sticker sets」页原本放在 Media 分组，只读展示 `telegram.sticker_sets` 同步下来的 Set 与索引。增删 Set 只能手改 `config.jsonc` 并重启，因为 `telegram.sticker_sets` 不在热更新白名单里，`StickerService` 也只在 Telegram 连接建立时按创建那一刻的配置同步一次。

用户提出四点需求：

- 页面移到 Telegram 分组，因为贴纸是 Telegram 特有的。
- 页面能热更新贴纸列表；添加或删除贴纸集时要能终止正在进行的 Invocation。
- 已添加的贴纸集不能改指向的 Telegram Set，但可以改昵称。
- 每个贴纸集加一个可选备注，说明什么时候该用，模型要能看到。

改动前还有一个潜在问题：`sticker_sets` 表的 `alias` 与 `telegram_name` 都是 `UNIQUE`，同步按 `alias` upsert。在配置里改昵称会插入一行同名 Set 的新行，撞上 `telegram_name` 唯一约束，整次同步失败。所以「可以改昵称」需要先把 Set 的身份从昵称换成 Telegram 名称。

## 主要变更

### 1. 配置：`note` 字段与热更新

`StickerSetSchema` 增加可选的 `note`（1–500 字符，`STICKER_SET_NOTE_MAX_LENGTH`），`validateSemantics` 对 `name` 改为大小写不敏感地判重（Telegram 的 Set 名称不分大小写）。`telegram.sticker_sets` 加入热更新白名单（`src/platform/config/diff-merge.ts:59`）。

### 2. 存储：按 Telegram 名称识别 Set（迁移 055）

`055_sticker_set_notes.sql` 用 `@rebuild-tables` 重建 `sticker_sets`：去掉 `alias` 的列级 `UNIQUE`，改为只在已配置行之间唯一的部分索引，并新增可空的 `note`：

```sql
CREATE UNIQUE INDEX sticker_sets_configured_alias_idx ON sticker_sets(alias) WHERE configured = 1;
```

新的 `reconcileStickerSets`（`src/capabilities/stickers/sets.ts:21`）是同步的纯存储对账：按小写名称找到已有行，只复制 `alias` 与 `note`；新增或重新添加的 Set 标为 `pending`；删除的 Set 停用贴纸并删除搜索行，但保留行和分析结果。它先把所有已配置行置为未配置再逐个启用，所以昵称互换、改用已删除 Set 的旧昵称都不会撞部分唯一索引（`src/capabilities/stickers/sets.ts:52`）。

`StickerService` 的配置改成按需读取的 getter；同步拆成 `sync()`（启动：对账 + 拉取全部 + 拉取期间新增的 `pending`）与 `refresh()`（发布后：只拉取未同步的 Set，然后唤醒索引 worker），拉取串行执行，并按行 id 写回。Telegram 返回时 Set 已被删除，就丢弃结果。重新启用的已索引贴纸如果没有搜索行，会回到 `pending`，worker 用缓存的分析重建搜索行，不再调用视觉模型（`src/capabilities/stickers/index.ts:253`）。

原 `src/capabilities/stickers.ts` 超过 pre-commit 的单文件上限，按职责拆成 `stickers/index.ts`（同步与索引 worker）、`stickers/sets.ts`（对账）与 `stickers/search.ts`（`search_stickers`，结果附带所属 Set 的昵称）。

### 3. 发布钩子：对账、中止、拉取

`publishStickerSets`（`src/adapters/local-monolith/runtime/sticker-sets.ts:33`）挂在 `serve` 的 `onPublished` 里，面板写入和「Apply config file」走同一条路径：

- `telegram.sticker_sets` 有变化就对账存储，所以没有 Telegram 连接时面板也能看到改动；`serve` 启动时也先对账一次。
- 按名称比较，Set 有增删时中止所有运行中的 Telegram Invocation（原因 `sticker_sets_changed`），Playground 房间不受影响；只改昵称或备注不中止。
- 有运行中的 Sticker worker 时在后台调用 `refresh()`，Telegram 慢不会拖住配置写入。

### 4. 模型可见的目录格式

注入批次的贴纸目录从单行的 `<untrusted_sticker_catalog>` 改为 `<sticker_catalog>`，每个 Set 一行（`src/context/builder/render.ts:386`）：

```txt
<sticker_catalog>
<sticker_set alias="cats" note="调侃朋友时使用">12:😺 13:😹</sticker_set>
</sticker_catalog>
```

`alias` 与 `note` 由运营者写入，Core Protocol 声明它们可信，`id:emoji` 仍不可信。所有值经 XML 转义，备注与 emoji 折成一行，`collectStickerCatalog` 只认行首的标签，因此消息正文伪造不出目录块。目录与 transcript 已携带的目录不同时才重新渲染，所以改备注在下一批注入时生效。稳定 system prompt 里的目录说明与 `sticker-search` Skill 同步更新；这会改变 system prompt 哈希，升级后每个 Conversation Context 重建一次。

### 5. Admin API 与面板

新增 `src/ingress/admin/routes/sticker-sets.ts`，接管 `GET /api/sticker-sets`（存储里的列表加上 `config.jsonc` revision，文件读不出时 revision 为 `null`），并提供 `POST /sticker-sets`、`PUT` / `DELETE /sticker-sets/:alias`。`POST` 接受 Set 名称或 `t.me/addstickers/<name>` 链接；`PUT` 只接受 `alias` / `note`，body 带 `name` 返回 400 `sticker_set_name_immutable`。`packages/admin-surface` 增加对应的 `sticker-set add/update/remove` 规格，CLI 与 MCP 随之获得这些操作。

前端把页面移入 Telegram 分组（路由仍是 `/stickers`），Set 表只显示已配置的 Set，增加备注列与编辑/删除操作，添加/编辑弹窗拆到 `apps/admin-next/src/pages/stickers-dialogs.tsx`；编辑时 Telegram 名称只读。有 Set 仍在同步或有待索引贴纸时列表每 3 秒刷新，否则 15 秒。

## 验证

```bash
pnpm run check
# 通过（tsc、cli、admin-next、docs）

pnpm run lint
# Checked 1296 files. No fixes applied.

pnpm test test/stickers.test.ts test/sticker-sets.test.ts test/skills.test.ts test/optional/vision.test.ts test/admin/sticker-sets.test.ts test/telegram
# 15 files / 101 tests passed（拆分 stickers.ts 之后）

pnpm test test/foundation/foundation.test.ts test/scene/retention.test.ts test/schema/migrations-mcp-images.test.ts test/tasks/migration-upgrades.test.ts
# 4 files / 19 tests passed（最新迁移版本断言从 54 更新为 55）

pnpm test
# 拆分前一轮：377 个文件中 4 个失败，7 个失败用例全是写死「最新迁移 = 54」的断言，已更新
# 拆分后一轮（即 4e6a6583）：378 files passed | 1 skipped；1823 tests passed | 8 skipped

pnpm run admin:build
pnpm run admin:test:e2e 31-sticker-sets 24-i18n 01-routes 02-lists-filters-resources 25-koi-crud-structure
# 79 passed；31-sticker-sets 产出 sticker-sets.png 与 sticker-sets.json

DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 均通过：Verified 50 HTML/Markdown pages ... 164 HTTP resources；构建后 git status 不变
```

未执行：真实 Telegram 验收（在面板添加真实 Set 后观察同步、索引进度，以及增删时正在回复的群聊被中止）。

## 提交

```txt
4e6a6583 Manage Telegram sticker sets with notes in the admin panel
```
