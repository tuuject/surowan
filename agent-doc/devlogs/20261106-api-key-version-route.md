# Surowan - 20261106 API key 读取运行时版本

## 背景

#59（runtime-version-awareness）在 `src/ingress/admin/inspection.ts` 新增 `GET /api/version`，约定 Session 与 Bearer key 都可读，并在 `test/admin/inspection.test.ts` 断言两种身份都返回 200。#60（mcp-server）同期把 Bearer key 请求改为先查 `@surowan/admin-surface` 的路由表：`src/ingress/admin/index.ts` 中 `findSurfaceSpec` 找不到的路由一律 403（不回 404，避免 key 枚举面板）。

两个 PR 基于同一个 develop 分别通过 CI，合并后 `version` 不在路由表里，API key 请求被拦成 403，develop 推送触发的 Docker workflow 在 `verify` 的 Tests 步骤失败：

```txt
FAIL test/admin/inspection.test.ts > version reports the running build to sessions and API keys
AssertionError: expected 403 to be 200
```

## 主要变更

### 1. 路由表补登 `GET version`

`packages/admin-surface/src/specs/audit.ts` 在 `key show` 之后新增一行：

```ts
{
  command: 'version show',
  method: 'GET',
  path: 'version',
  summary: 'Show the running Surowan build version and release channel',
},
```

GET 默认 `read` 权限，所有 key 都能访问。没有设 `cli: false`，所以同一行同时生成 `surowan-utils version show` 面板命令与 MCP 工具 `surowan_version_show`；服务端处理仍是 inspection 里原有的分支，不新增实现。

### 2. 文档同步

- `packages/cli/src/usage.ts` 的面板命令摘要加入 `version show`。
- `skills/surowan-mcp/references/tools.md` 的工具索引加入 `surowan_version_show`。
- `agent-doc/admin-panel.md` 已写明 `/version` 是 Session 与 Bearer key 共用的只读检查路由，无需改动。

## 验证

```bash
# 修复前在 develop（c146c0e）复现
npx vitest run test/admin/inspection.test.ts -t "version reports"
# 1 failed：expected 403 to be 200

git diff --check
# 无输出

pnpm run lint
# biome lint + format 通过

pnpm run check
# runtime / cli / docs tsc 通过

pnpm --filter @surowan/admin-surface run build
# 包入口是 dist/，本地改源码后需重新构建；CI 由 pnpm install 的 prepare 构建

npx vitest run test/admin/inspection.test.ts test/admin/mcp.test.ts test/cli/panel
# 6 files / 27 tests passed

pnpm test
# 364 files passed，1 failed：test/playground/only.test.ts 的 attempt 仍为 running 且 afterEach 超时
npx vitest run test/playground/only.test.ts
# 单独重跑 1 passed；该用例只走 Session，与本次路由表改动无关
```

未执行：Admin Panel e2e（前端与面板文案未改动）；真实环境中用 `surowan-utils version show` 与 MCP 客户端调用 `surowan_version_show`。

## 提交

```txt
c91ac20 Allow API keys to read the runtime version
```
