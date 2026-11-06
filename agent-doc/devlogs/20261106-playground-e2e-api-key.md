# Surowan - 20261106 Playground E2E 按 API key 模式断言

## 背景

合并 #61 后，develop 推送触发的 Docker workflow（run 42166472618）通过了 Tests，却在 `verify` 的 Admin panel E2E 步骤失败，205 个用例里只有 1 个失败：

```txt
e2e/20-playground.e2e.ts:14:1 › the playground API is session-only and never answers an API key
Expected: 403
Received: 200
```

这个用例写于 Playground 只对面板 Session 开放的时期。#60（mcp-server）按 `doc/design/20261105-mcp-server.md` 把 Playground 纳入 API key 权限面：读端点要 `read`，写端点要 `write`，放行与重试要 `write+paid`，`agent-doc/admin-panel.md` 的写端点表也已按此更新。服务端行为符合 PRD，过时的是 E2E 断言。PR 上的 CI 不跑 Admin E2E；develop 上 `c146c0e` 那次又先在 Tests 步骤失败（#61 修复），所以这个问题直到现在才暴露。

## 主要变更

### 1. E2E 断言改为按模式授权

`apps/admin-next/e2e/20-playground.e2e.ts` 的首个用例更名为 `the playground API needs a session or an API key whose mode grants the route`：

- 匿名请求与无效 key 仍为 401。
- 显式创建 `mode: 'read'` 的 key（不依赖默认的 `read_paid`）：`GET /api/playground/rooms` 返回 200；`POST /api/playground/rooms` 返回 403，且 `message` 含 `lacks write`，以确认是被权限闸门拒绝，不是路由表未登记的 403。
- Session 读取仍为 200，key 在 `finally` 中撤销。

### 2. 过时描述

- `packages/admin-surface/src/specs/playground.ts` 删除头注释里的「session-only」。
- `agent-doc/verification.md` 的 `20-playground.e2e.ts` 说明改为「匿名与无效 key 401、只读 API key 能列房间但建房得 403」。

## 验证

```bash
pnpm run admin:build
pnpm run admin:test:e2e 20-playground
# 18 passed（含 20-playground-ui）

git diff --check
# 无输出

pnpm run lint
# biome lint + format 通过

pnpm run check
# runtime / cli / admin-next / docs tsc 通过
```

未执行：完整 Admin E2E（失败的 CI run 中其余 204 个用例已通过）；完整 `pnpm test`（本次只改 E2E、注释和文档）。

## 提交

```txt
ee0c805 Assert Playground API key access by mode in e2e
```
