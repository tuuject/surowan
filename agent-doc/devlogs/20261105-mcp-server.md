# Surowan - 20261105 MCP Server、API key 权限模式与 MCP with Skills

## 背景

塑料碗此前只有 MCP Client，外部 Agent 想操作塑料碗只能走 `surowan-utils` CLI；CLI 的完整面板能力依赖用户名/密码换来的面板 Session，API key 则被固定为只读检查与 Invocation 重放。PRD `doc/design/20261105-mcp-server.md` 要求：

- 服务端内置 MCP Server，使用 Streamable HTTP + `Authorization: Bearer <token>`；
- API key 增加 `read:all`、`write:all`、`execute:paid-operations` 三项权限，但只向用户暴露只读、读+改、读+耗、全部四种模式；
- MCP 能力与 Admin Panel 一一对应，账号与凭据操作整类排除；
- 支持 MCP with Skills，同时保留可单独安装的 `surowan-mcp` Skill；
- `surowan-utils` 删除用户名/密码登录与 `setup`，只用 API key。

## 主要变更

### 1. API key 权限模型与迁移

`src/store/migrations/053_api_key_permissions.sql` 给 `admin_api_keys` 增加三列；已有 key 得到 `read_all = 1`、`write_all = 0`、`execute_paid_operations = 1`，保留原有重放能力。

`src/ingress/admin/api-keys.ts` 现在负责：

```ts
export type ApiKeyMode = 'read' | 'read_write' | 'read_paid' | 'all';
export interface ApiKeyPermissions {
  readonly read_all: boolean;
  readonly write_all: boolean;
  readonly execute_paid_operations: boolean;
}
```

- `createApiKey` / `updateApiKeyMode` / `rotateApiKey` 只接受四种模式；rotate 保留名称、模式与 `created_at`，只换明文并清空 `last_used_at`。
- `authenticateApiKey` 对 `read_all = 0` 的非法组合返回 `null`，该 key 无法工作；`invalidApiKeys` 供启动日志与 Warnings 页使用。
- `accessAllowed` 把 `EndpointSpec.access` 映射到三份权限，其中 `write+paid` 需要两个附加项同时开启。
- `GET /api/key` 返回当前 Bearer key 的 `mode` 与 `permissions`；MCP 的 `surowan_key_show` 是同一能力的工具。

`src/platform/warning-catalog.ts` 新增 `api_key_invalid_permissions` 常态警告；`src/ingress/admin/warnings.ts` 在列表时把非法 key 拼进 `standing`；`AdminServer.start()` 同时输出一条 `api_key_invalid_permissions` 控制台警告。

### 2. Admin API 统一权限闸门

`src/ingress/admin/index.ts` 不再使用固定 inspection allowlist。Bearer 请求先鉴权，再用 `findSurfaceSpec(method, segments)` 查 `EndpointSpec`：

```ts
const access = specAccess(found.spec);
if (!accessAllowed(key.permissions, access)) {
  return json(
    { error: 'forbidden', message: `This API key lacks ${access} permission; enable it in Admin Panel → API keys` },
    403,
  );
}
```

之后与面板 Session 共用 `#dispatchAuthenticated`，因此 routes、Origin、body 限制与审计只有一套实现。`/api/auth/*` 与 `/api/api-keys*` 对 Bearer 一律 403；未知路径同样 403，避免枚举。Invocation replay 仍走 `routes.inspection.replay`，但必须先通过 `paid` 权限检查。

`src/ingress/admin/inspection.ts` 只保留 inspection 读取与 replay，不再维护第二份 key 权限表。

### 3. 共享 Admin 路由表

新增 `packages/admin-surface/`，把 `EndpointSpec` 与全部路由表从 CLI 移出，并加入：

- `access`：显式标注只读 POST、计费与 `write+paid` 端点；
- `cli === false`：已有 first-class CLI 命令的 Invocation/配置视图；
- `mcp === false` 与 `auth/`、`api-keys` 前缀：账号凭据排除；
- `specAccess`、`specIsMcpExposed`、`findSurfaceSpec`。

CLI 通过 `@surowan/admin-surface` 读取同一张表；该 workspace 包作为 `bundledDependencies` 打进 `surowan-utils` tarball，因此发布包仍自包含。`packages/cli/src/panel/specs/*` 的旧副本已删除。

### 4. MCP Server

`src/ingress/admin/mcp/` 新增：

- `index.ts`：`/mcp` Streamable HTTP。现代请求（`MCP-Protocol-Version: 2026-07-28` 或 `_meta` 声明）由本模块无状态处理 `server/discover`、`tools/*`、`resources/*`、`skills/*`、`ping`；legacy `initialize` 交给 MCP SDK 的 `WebStandardStreamableHTTPServerTransport`。两种 era 共享同一工具目录与 Skill manifest。
- `tools.ts`：从 `EndpointSpec` 生成 `surowan_<command>` 工具。参数包含路径/查询参数、`body`、`if_match`、`confirm`、`dry_run`；执行时用同一 Bearer key 调回 Admin API，权限、错误与审计不另起一套。
- `skills.ts`：读取 `skills/surowan-mcp/`，生成 `skill://surowan-mcp/...` manifest（每个文件带 SHA-256 与字节数），实现资源读取与目录列举。

MCP Server 与 Admin Panel 同一监听端口；`admin.enabled = false` 时两者都不启动。Docker 运行时镜像补充复制 `packages/admin-surface/dist` 与 `skills/`。

### 5. MCP with Skills 与独立 Skill

- 服务器 capability 声明 `io.modelcontextprotocol/skills`（`directoryRead: true`），`skills/list` / `skills/get` / `resources/read` / `resources/directory/read` 均可用。
- 新增 `skills/surowan-mcp/SKILL.md` 与 `references/tools.md`：先 `surowan_key_show`，再按模式执行；权限不足时停止并请用户改 API key，不寻找绕过；写入/计费逐步确认。
- `surowan-utils` Skill 同步改为 API key 模式，删除面板 Session 与 `login --username` 说明。

### 6. CLI 只保留 API key

`packages/cli/src/`：

- `credentials.ts` 只保存 `{ endpoint, apiKey }`；旧的 session 文件按 `invalid_credentials` 拒绝，需操作员重新 `login`。
- `login` 必须显式提供 endpoint 与 key（`--api-key` / `--api-key-stdin` / 环境变量）；删除交互式用户名密码提示与 `panel/login.ts`。
- `args/` 删除 `--session`、`--username`、`--password`、`--password-stdin`、`SUROWAN_SESSION` 与 `setup` 预鉴权特例。
- `doctor` 先 `GET /api/key` 读取 `mode`/`permissions`，再 `GET /api/invocations?limit=1`；输出新增两个字段，供 Skill 判断权限。
- `panel/specs/auth.ts` 等 Session 命令不再出现在 CLI 命令表；账号、Passkey 与 API key 管理只在浏览器面板。

### 7. Admin Panel 与文档

- `/api-keys` 页面新增 Mode 列、四模式下拉、Change mode、Rotate；创建仍只显示一次明文。脏数据（`mode: null`）显示 Invalid permissions，页面不崩。
- Warnings 页新增 `api_key_invalid_permissions` 模板与“打开 API keys”动作。
- `agent-doc/admin-panel.md` 重写 API key 与 MCP 章节；`architecture.md`、`data-layer.md`、`operations.md`、`verification.md` 同步。
- `apps/docs` 重写 API keys 页，新增 `configure/mcp-server.md` 与 MCP Agent 接入说明；CLI README / REFERENCE / Skill 文档同步。
- `scripts/docs/verify.ts` 在比较前统一把生成 Markdown 的 CRLF 归一为 LF，使 Windows 本地验证与 Linux CI 一致。

## 验证

```bash
pnpm run lint
pnpm run check
pnpm test
# 364 passed | 1 skipped (365 files), 1718 passed | 8 skipped (1726 tests)

pnpm run admin:build
pnpm run admin:test:e2e 01-routes 14-api-keys
# 33 passed

pnpm exec vitest run test/admin/mcp.test.ts test/admin/api-keys*.test.ts \
  test/prompts/admin-global.test.ts
# 17 passed

pnpm run docs:build && pnpm run docs:verify
# Verified 49 pages ... (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 49 pages ... (base /surowan/)

git diff --check
# clean
```

真实 Telegram、真实 Provider 调用与 `surowan` 服务端 CLI 未在本工作树执行。

## 提交

```txt
37e537f Add MCP server and API key permission modes
aefff01 Allow MCP dry runs without confirmation
```
