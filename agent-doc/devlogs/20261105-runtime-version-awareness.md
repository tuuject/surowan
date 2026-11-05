# Surowan - 20261105 运行时版本号感知

## 背景

Public Release 临近，用户需要知道自己运行的 Surowan 版本、反馈问题时能给出准确版本，后续也才能做更新检查。此前运行时没有版本号来源：`package.json` 的 `version` 是仓库自身的版本字段，开发版可能显示得比正式版还新，不能拿来判断部署版本。

需求是建立一条分层的版本来源：打包镜像内的 `version` 文件优先，其次是精确指向当前 `HEAD` 的 Git tag，再次是当前 commit 的 Develop 版本，最后回退到固定 Develop 版本。本次只在 Admin Panel 展示版本与 Channel；检查更新基建推迟到 Phase 2。

## 主要变更

### 1. 版本解析与比较

新增 `src/platform/version.ts`：

- 解析 `v1.0.0`（Release）、`v0.0.0-next-<14 位时间戳>`（Staging）、`v0.0.0-develop[-<hash>]`（Develop），并拒绝不合法的 Channel 后缀。
- `resolveVersion(root)` 的优先级：`<root>/version` → `git tag --points-at HEAD` 的精确 tag → `git rev-parse --short=8 HEAD` → `v0.0.0-develop`。
- 同一 commit 有多个 tag 时按 `Release > Staging > Develop` 取；同 Channel 内 Release 用 SemVer、Staging 先比基础版本再比时间戳、Develop 按 hash 稳定排序。
- `currentVersion()` 进程内缓存；`versionUserAgent()` 与 `webFetchUserAgent()` 统一生成出站 UA。

Docker 写入的 `version` 文件格式：

```txt
Version: v1.0.0
Channel: Release
```

### 2. Admin Panel

- `src/ingress/admin/inspection.ts` 新增 `GET /api/version`，返回 `{ version, channel }`，Session 与 Bearer key 都可读。
- `apps/admin-next/src/lib/api/version.ts`、`queries.ts` 与 `components/layout/app-sidebar.tsx`：侧栏底部展示完整版本号与 Channel，折叠为图标时隐藏。
- `apps/admin-next/e2e/01-routes.e2e.ts` 在概览页断言版本节点可见。

### 3. 出站 User-Agent

- `web_fetch`：`Mozilla/5.0 Surowan/<version>`。
- Web Search、Provider 模型发现、OpenRouter 图片目录/图片生成、MCP HTTP、Telegram 媒体下载：`Surowan/<version>`。
- 图片生成适配器新增可选 `userAgent`，由 `src/image/service.ts` 注入；MCP 在 `requestInit` 与自定义 `fetch` 两处都补齐，避免 SDK 覆盖。

### 4. Docker 发布

- `Dockerfile` 运行时阶段接受 `SUROWAN_VERSION` / `SUROWAN_CHANNEL`，生成 `/app/version`；本地无参构建不生成该文件，走 Git/固定回退。
- `.github/workflows/docker.yml` 对 `main` 写 Staging（`v0.0.0-next-<UTC 时间戳>`），对 `v*` tag 写 Release（tag 本身），并作为 build args 传入。
- `.dockerignore` 与 `.gitignore` 排除本地 `version` 文件，避免误打包/误提交。

### 5. 测试与文档

- `test/version.test.ts`：解析、比较、version 文件优先级、精确 tag 选择、未打 tag 的 commit、无 Git 回退、UA。
- `test/admin/inspection.test.ts` 与 `test/web-search/tool.test.ts` 覆盖版本端点和搜索 UA。
- 同步 `agent-doc/admin-panel.md`、`agent-doc/operations.md` 与 `apps/docs/content/docs/operations/upgrade.md`。

## 验证

```bash
git diff --check
# 无输出

pnpm run lint
# biome lint + format 通过（1232 / 1229 个文件）

pnpm run check
# runtime / CLI / Admin / docs TypeScript 检查通过

pnpm test
# 364 files passed | 1 skipped；1730 tests passed | 8 skipped

pnpm run admin:build
# 生产 SPA 构建通过

pnpm run admin:test:e2e 01-routes
# 23 passed

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 48 HTML/Markdown pages, 158 HTTP resources

DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 48 HTML/Markdown pages, 158 HTTP resources

node -e "import('./src/platform/version.ts').then(m=>console.log(JSON.stringify(m.currentVersion()), m.versionUserAgent(), m.webFetchUserAgent()))"
# {"version":"v0.0.0-develop-ea1d096f","channel":"Develop"} Surowan/v0.0.0-develop-ea1d096f Mozilla/5.0 Surowan/v0.0.0-develop-ea1d096f
```

## 未执行

- 真实 `docker build` / 镜像内 `/app/version` 验收：当前环境没有 `docker` 命令。Dockerfile 的生成命令已用 shell 模拟，`version` 文件解析已用临时目录验证。
- 真实外部 Provider、MCP Server 与 Telegram 媒体下载的 UA 验收；这些路径只覆盖到代码与测试，未做线上抓包。

## 提交

```txt
ea1d096 Add runtime version awareness
```
