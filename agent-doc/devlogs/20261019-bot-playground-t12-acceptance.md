# Plastic Wan - 20261019 Bot Playground T12：MVP 全链路验收与交付

## 背景

[Bot Playground Epic](../design/20261016%20Bot%20Playground%20Epic%20与实施交接.md) 的 P0 Critical Path（T00–T11）已全部落地：宿主中立存储、虚拟交付、Hold/Release、执行隔离、本地媒体、生图 opt-in、Admin API、`--playground-only` 与页面。T12 是合并/发布验收门：完整跑一遍自动化门，执行持久化/重启/并发/失败/保留的混合宿主矩阵，补齐用户文档，并把人工验收项的实际状态写清楚——不拿 Faux 证明真实外部连接。

## 主要变更

### 1. 自动化验收门

全部在 `feature/bot-playground` worktree 实测通过：

- `pnpm test`：125 个测试文件、1532 项测试全绿（含全部 Playground 套件与既有 Telegram 合同套件）。
- `pnpm run check`（runtime + CLI + Admin + docs 的严格 tsc）、`pnpm run lint`、`git diff --check`：通过。
- `pnpm run admin:build` + 完整 `pnpm run admin:test:e2e`：172 项 Playwright 用例全绿，含 `20-playground.e2e.ts` 的 12 项房间/页面用例与 `00-auth`、`04-writes`、`05-readonly-security`、`06-trust-boundary` 边界套件。
- 文档站：`pnpm run docs:build`、`pnpm run docs:verify`（24 个 HTML/Markdown 页面、86 个 HTTP 资源）与 `docs-examples`/`docs-search`/`docs-markdown` 测试通过。

### 2. 验收矩阵（V01–V17）证据归位

Epic §7 的矩阵由现有自动化套件覆盖，TG 合同与 PG 隔离两侧同时断言：

- V01（TG 原行为）：`test/context-send.test.ts`、`send-reply.test.ts`、`reply-dedup.test.ts`、`typing.test.ts`、`scheduler.test.ts`、`telegram-ingestion.test.ts`、`startup-catch-up.test.ts`、`context-gc.test.ts` 等既有套件，加 `test/im-host-contract.test.ts` / `im-host-pinned-surface.test.ts` 固定的跨宿主合同。
- V02–V08（多用户、Hold、Release 顺序、合批、运行中再 Hold、幂等、失败/重试守卫）：`test/playground-ingestion.test.ts`（16）、`playground-scheduler.test.ts`（4）、`playground-runtime.test.ts`（1）、`playground-context.test.ts`（8）、`test/admin-playground.test.ts`（15），断言均落到 Store/Scheduler/Provider 请求而非 UI 文案。
- V09（退出与重启）：`test/playground-only-serve.test.ts` 用真实 `serve --playground-only` 子进程验收启停与缺面板拒绝；`a queued release survives a restart and runs once on startup` 覆盖 queued 重启恢复；`expireQueued` 的五分钟上限由 `test/playground-ingestion.test.ts` 覆盖。
- V10（整批拒绝）：`test/playground-context.test.ts` 与 `test/host-boundary.test.ts`。
- V11–V13（输出只在当前虚拟群、零 Telegram 网络、副作用隔离）：`test/playground-delivery.test.ts`、`playground-only.test.ts`（`a playground-only process runs the room round and leaves Telegram work untouched`，TG 工作计数为零且原样保留）、`playground-host-profile.test.ts`。
- V14（媒体与生图）：`test/playground-media.test.ts`、`playground-image.test.ts`（fake Provider 全链路含配额拒绝零计费）。
- V15–V16（Admin 边界、UI 恢复）：`test/admin-playground.test.ts` + `20-playground.e2e.ts`（session-only、跨房间 404、key 幂等、丢响应重试、窄屏、深链恢复）。
- V17（升级/保留/备份）：迁移 `036`/`037`/`041`/`042` 的空库与旧库升级 fixture、房间资产备份恢复、保留期 held 输入过期与台账保留，见 `test/schema.test.ts`、`store-boundary.test.ts`、`playground-ingestion.test.ts`、`playground-image.test.ts`。

### 3. 用户与主题文档

- 新增用户指南 `apps/docs/content/docs/guides/playground.md`（guides 导航与首页入口同步更新），覆盖建房/身份、Hold/Release 语义、图片上传限制（JPEG/PNG/WebP，10 MiB / 4000 万像素、拒绝动图）、运行状态与保守重试、生图开关的真实计费提示、`playground` 用量域与数据边界。
- `AGENTS.md` 的 Where to Look 增加 Playground 行，指向 `admin-panel.md#playground-页端点`、`operations.md#playground-only-模式`、`data-layer.md` 的虚拟房间节。
- Epic 追加 §9 交付指针；历史规划正文不改写。

### 4. 人工验收状态（按 Epic §7「必须保留的人工验收步骤」逐项记录）

- 步骤 1（隔离数据目录、无 Telegram 凭据、TG 网络 deny 下启动 PG-only）：**由自动化覆盖**——`test/playground-only-serve.test.ts` 真实子进程 + `test/playground-only.test.ts` 的 Telegram 构造/API/getFile/Sticker/MCP 计数全零断言。
- 步骤 2–6（真实 Provider 下的文本/图片理解/授权生图试跑）：**未执行**。需要维护者授权的真实 Provider 凭据与计费许可，本次环境不可用；Faux/本地 Responses 夹具已证明状态机与调用参数，不证明真实模型发言、图片理解或计费。合并前建议由维护者在隔离 `data_dir` 按指南操作一轮。
- 步骤 7（测试 Telegram 群回归）：**未执行**。需要维护者提供的测试群环境；TG 侧合同由 V01 自动化套件固定。

## 验证

```bash
pnpm test
# Test Files  125 passed (125)
# Tests  1532 passed (1532)

pnpm run check          # 通过（runtime/cli/admin/docs tsc）
pnpm run lint           # 通过
git diff --check        # 通过

pnpm run admin:build && pnpm run admin:test:e2e
# 172 passed

pnpm run docs:build && pnpm run docs:verify
# Verified 24 HTML/Markdown pages, search, examples, schema, provenance and 86 HTTP resources (base /).

pnpm test test/docs-examples.test.ts test/docs-search.test.ts test/docs-markdown.test.ts
# 8 passed
```

## 数据库 / 配置 / 费用与恢复行为（PR 说明口径）

- 数据库：迁移 `036`–`042` 随 Epic 分任务落地，本次无新增迁移；旧库升级路径与备份恢复由 V17 套件覆盖。
- 配置：无 schema 变化；`telegram` 段在 `--playground-only` 下仍是结构占位（E05 再精简）。
- 费用：Playground 的 Agent/Vision 用量记入 `playground` 计量域并与 Telegram 分开累计；房间生图默认关闭，开启即真实计费并记录操作者。
- 恢复：`--takeover`、ServeLock、优雅关闭与 PG-only 一致；混合库上 PG-only 不触碰 Telegram 工作状态。

## 提交

```txt
8c347f5 Document the Playground MVP and close out the epic
```
