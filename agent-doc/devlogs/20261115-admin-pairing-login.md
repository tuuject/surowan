# Surowan - 20261115 Admin Panel 一次性码登录

## 背景

用户希望 Admin Panel 登录页多一个入口：输入后端 CLI 生成的一次性 token 就能登录网页，并且复用之前给 `surowan-utils` 做的 pairing 机制（PR #85，迁移 `058`）。

改动前，浏览器只有两种登录方式：密码和 Passkey（需要配置 `admin.public_url`）。忘了密码又没有 Passkey 时，只能停掉 Bot 跑 `admin-account` 重置。pairing 机制已经有服务端 `surowan pairing create|list|cancel`、`pwp_` 码（数据库只存摘要）、TTL 和一次性消费，但只能由 `POST /api/pairing/claim` 换成 Ed25519 签名客户端。

关键约束：

- Agent 配对码不能在网页上直接登录。`--mode read` 的码要是能换出完整面板 Session，就等于提权。
- 浏览器登录码也不能被 `auth pair` 领取成一个全权限客户端。
- 被拒绝的尝试不能烧掉别人的码。
- 旧表的 CHECK `(consumed_at IS NULL) = (client_id IS NULL)` 不允许消费后不带 client，SQLite 又不能原地改 CHECK。

## 主要变更

### 1. 迁移 059：票据带用途

`src/store/migrations/059_admin_web_pairings.sql` 用 `@rebuild-tables` 重建 `admin_pairings`，新增 `purpose`（`client` / `web`）和 `user_id`（引用 `admin_users`，级联删除）。058 的票据全部转成 `client`，id 和生命周期列原样保留。两种用途靠 CHECK 隔开：

```sql
CHECK (purpose <> 'client' OR (user_id IS NULL AND (consumed_at IS NULL) = (client_id IS NULL))),
CHECK (
  purpose <> 'web'
  OR (
    user_id IS NOT NULL AND public_key IS NULL AND client_id IS NULL
    AND read_all = 1 AND write_all = 1 AND execute_paid_operations = 1
  )
)
```

`web` 票据的三个权限位固定为 1，因为面板 Session 就是整个面板，这样 `pairing list` 显示的 `mode: all` 也如实。表用的是 AUTOINCREMENT，重建时把 `sqlite_sequence` 的高水位一并带到新表，已清理票据的 id 不会被重新分配。Drizzle 定义同步在 `src/store/schema/admin.ts`。

### 2. CLI：`pairing create --web`

- `src/cli-options.ts:131` 解析 `--web`，产出新的命令 `pairing-create-web`。
  - `--mode` 和 `--public-key` 直接拒绝；`--name` 可以省略，默认 `Admin Panel sign-in`。
  - `--web` 出现在其他子命令上，或重复出现，都是 usage 错误。
- `createWebPairing`（`src/ingress/admin/clients/index.ts:175`）在创建时把票据绑定到唯一的管理员。规则与 `admin-account` 一致：没有账号就报错（提示先完成 setup），多于一个账号也拒绝。原 `createPairing` 与它共用 `insertPairing`。
- `src/ingress/admin/clients/cli.ts` 两种 create 共用输出结构。
  - web 票据的 `next` 改成「打开面板地址，选 Sign in with a one-time code，在 `expires_at` 前粘贴」。
  - 地址提示抽成 `panelEndpoint`，仍然是 `public_url` 或 SSH 隧道本地端。
- 所需迁移版本提到 59。

### 3. 登录端点与用途过滤

`POST /api/auth/pairing`（`src/ingress/admin/routes/auth.ts:157`）调用 `claimWebPairing`（`src/ingress/admin/clients/web-login.ts:27`），成功后签发与密码登录相同属性的 Session Cookie。

- body 只接受 `{ code }`，上限 1 KiB。形状不对一律 `invalid_body`，不查库。
- 查码、状态检查、消费和建 Session 都在同一个 immediate 事务里，所以两个并发请求只会产生一个 Session。错误码沿用 claim 端点：`pairing_code_invalid`、`pairing_code_expired`、`pairing_code_used`（409）。
- 码有 192 位随机量、最多活一小时且只能用一次，所以不走密码登录的失败计数和锁定。

两个端点都按用途过滤，对方用途的码查不到，就当作 `pairing_code_invalid`，也不会被消费：

```ts
// src/ingress/admin/clients/pairing.ts:64
.where(and(eq(adminPairings.codeHash, hashToken(body.code)), eq(adminPairings.purpose, 'client')))
```

`AdminAuth.createPasskeySession` 改名为 `createVerifiedSession`（`src/ingress/admin/auth.ts:337`），Passkey 和一次性码共用这个入口：更新 `last_login_at`，清零登录失败告警计数，再建 Session。

### 4. 登录页

`apps/admin-next/src/pages/auth.tsx`：

- `LoginForm` 改成在密码表单和 `PairingCodeForm` 之间切换。
  - 密码页在分隔线下方新增「使用一次性码登录」按钮。Passkey 按钮仍然只在启用时出现，两个按钮同一尺寸。
  - 码页有一个等宽输入框（LTR）、帮助行和「使用密码登录」返回按钮。帮助行里的 `pairing create --web` 用 `TechText` 加等宽字体，阿拉伯语下也保持 LTR。
- 前端先校验码的形状，容忍终端复制带来的首尾空格，提交前 trim。
- 接口 `loginWithPairingCode` 在 `apps/admin-next/src/lib/api/auth.ts`。
- 文案 en / zh-CN / de-DE / ar 四份同步。

### 5. 文档

- `agent-doc/admin-panel.md`：「认证」新增一次性码登录，「已配对 Agent 客户端」新增用途隔离，写端点白名单加入 `POST /auth/pairing`。
- `agent-doc/data-layer.md`：记录迁移 059。
- `agent-doc/operations.md`：记录 `pairing create --web`。
- `agent-doc/verification.md`：补上 e2e 覆盖契约。
- 用户指南：`apps/docs/content/docs/configure/admin.md` 新增「用一次性码登录」一节，恢复一节指向它；`reference/cli.md` 与 `admin-agent-pairing.md` 的迁移版本改为 059。

## 测试

按仓库规则先写下失败模式，再写测试和实现。失败模式写在 `test/pairing/web-login.test.ts` 的头注释里：

1. 两种用途互相串用。
2. 被拒的尝试烧掉了码。
3. 码能用两次，或并发领取产生两个 Session。
4. 过期或已取消的码仍能登录。
5. 畸形 body 进入了查库。
6. 码明文落库，或 Cookie 丢了 HttpOnly / SameSite=Strict。
7. 没有管理员时也能建票据，或 `--web` 与 client 专属参数混用。

测试一律用真实 AdminServer 加真实服务端 CLI 子进程：

- `test/pairing/web-login.test.ts`：5 个用例，覆盖上面 7 条。
- `test/schema/migrations-admin-web-pairings.test.ts`：从 058 升级，确认旧行变成 `client`、`client_id` 保留，各条 CHECK 与外键会拒绝非法行，AUTOINCREMENT 高水位延续。
- 4 个测试文件里断言最新迁移版本的地方从 58 改为 59；`pairing-flow` 的迁移提示断言改为 `migration 059`。

E2E 在 `apps/admin-next/e2e/00-auth.e2e.ts`：

- 新的 `/__e2e/pairing-create` 钩子对 e2e 服务器的配置和数据库运行真实的 `pairing create` CLI。
- 浏览器流程依次走过：
  - 畸形码报表单错误；
  - 带空格的真码进入 shell；
  - 登出后同一码报 `pairing_code_used`；
  - Agent 码报 `pairing_code_invalid`；
  - 返回密码表单。
- `/__e2e/pairing-rows` 断言票据状态和 Session 行数，并输出 JSON 与码表单截图作为产物。

## 验证

```bash
pnpm run check
# exit 0
pnpm run lint
# exit 0（lint:fix 先格式化了 3 个新/改的测试文件）
git diff --check
# exit 0
npx vitest run test/pairing test/schema test/foundation test/scene/retention.test.ts test/tasks/migration-upgrades.test.ts test/admin/auth.test.ts test/admin/passkeys-lifecycle.test.ts
# 24 files passed, 121 passed / 1 skipped
pnpm run admin:build && pnpm run admin:test:e2e 00-auth 01-routes 16-passkeys 24-i18n 30-dev-mock 05-readonly 06-trust
# 48 passed
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 53 HTML/Markdown pages, search, examples, schema, provenance and 173 HTTP resources (base /).
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 53 HTML/Markdown pages ... 173 HTTP resources (base /surowan/).
git status --porcelain
# 构建后只剩本次的源码改动，没有生成物
pnpm test
# 395 files passed / 1 failed / 1 skipped；1947 passed / 1 failed / 9 skipped
```

唯一的失败是 `test/recurring-alarms/schedule.test.ts` 的 croner 导入路径断言：Windows 上 `path.relative()` 得到反斜杠。`20261114-agent-cli-secure-pairing` 已记录它在未改动的 develop 上同样失败，与本次改动无关。

视觉检查：

- 用一个临时 Playwright spec 截图后删除，截了 en / zh-CN / ar × 浅色 / 深色 × 桌面 / 手机宽度，密码页和码页都看过。
- 阿拉伯语 RTL 下，输入框和命令片段保持 LTR，没有横向溢出。

未执行：

- 真实 VPS 上 `docker compose exec -u surowan … pairing create --web` 加 SSH 隧道登录的人工验收。
- 配置了 `admin.public_url` 时，Passkey 按钮与一次性码按钮并列的截图（`16-passkeys` 套件通过，但没有专门截图）。
- POSIX 下 CLI 的 0600/0700 权限路径（Windows 跳过，留给 Linux CI）。

## 后续：只对官方镜像显示 Docker 命令

PR 审阅时，用户提出：Docker 部署的用户需要知道该敲哪条 `docker compose` 命令，但这条提示只在官方 Docker 实例里给；用户自己构建的塑料碗镜像，我们不为它的用法负责。

- `Dockerfile` 的 runtime 阶段设置 `ENV SUROWAN_OFFICIAL_IMAGE=1`。凡是基于官方镜像（包括 `FROM` 它再扩展）或用本仓库 `Dockerfile` 构建的镜像都带这个标记，它们的用户、路径都与提示里的命令一致。
- `GET /api/auth/session` 新增 `official_docker_image`，取值是 `process.env.SUROWAN_OFFICIAL_IMAGE === '1'`，每次请求现读。只有恰好为 `'1'` 时才算官方镜像。
- 一次性码表单（`apps/admin-next/src/pages/auth.tsx`）在官方镜像下的帮助行显示：
  - 「在服务器上 `docker-compose.yml` 所在的目录运行：」
  - 完整命令 `docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web`，等宽显示，可在任意位置换行，带复制按钮。
- 其他部署保持通用的 `pairing create --web` 提示。service 名 `plasticwan` 来自 `docker-compose.yml` 模板，自建镜像或改过 compose 的部署不一定一致，所以不替它们猜。
- 这个字段对未登录访客可见，只透露「是官方镜像」，不含路径或配置。

测试同样先写：`test/pairing/web-login.test.ts` 补了第 8 条失败模式（非官方部署被显示官方命令），新用例断言变量缺失或取值为 `'true'` 时都是 `false`，只有 `'1'` 是 `true`。`test/admin/auth.test.ts` 的 session 全量断言补上这个字段。E2E 新增「only the official Docker image is shown its docker compose command」：

- 默认状态下只有通用提示，页面上没有 Docker 命令。
- 用 `/__e2e/official-image` 钩子打开标记后，页面显示完整命令；点复制，通过剪贴板权限读回的内容与命令一字不差；同时截图作为产物。
- e2e 服务器启动时删掉这个变量，开发机或 CI 环境里的值不会影响结果。

```bash
pnpm run lint && pnpm run check && git diff --check
# 全部 exit 0
npx vitest run test/admin test/pairing
# 57 files passed, 257 passed / 1 skipped
pnpm run admin:build && pnpm run admin:test:e2e 00-auth 01-routes 14-api-keys 16-passkeys 24-i18n 30-dev-mock
# 53 passed
DOCS_BASE_PATH=/ 与 /surowan/ 各跑 docs:build + docs:verify
# 两次都 Verified 53 HTML/Markdown pages ... 173 HTTP resources
```

视觉检查：临时截图看了 zh-CN 深色桌面、zh-CN 浅色手机、ar 浅色手机、de-DE 深色手机，四种情况的 `scrollWidth` 都不超过视口。截图后把 `docker-compose.yml` 这类短技术片段设成不换行，以免在连字符处断开。

未执行：没有在本机 `docker build` 镜像去确认 `SUROWAN_OFFICIAL_IMAGE` 在容器里生效，留给 `docs.yml` 的 image-smoke 和真实部署验收。

## 后续：移除网页建号，首次登录改用一次性码

用户提出：彻底移除全新实例在网页上设置用户名和密码的流程，以防有人扫描到刚部署好的塑料碗实例，抢先完成安装；第一次部署就用一次性码登录，默认用户名是 `admin`，之后要不要改用户名、设密码或加 Passkey，由用户自己决定。

### 实现

- **删除网页建号**：`POST /api/auth/setup`、`AdminAuth.createFirstUser`、admin-surface 的 `setup` spec 和前端的 `SetupForm` / `createFirstAdmin` 全部删除，没有保留兼容路径。匿名 POST 到这个地址，会和其他未登录请求一样得到 401。
- **首次登录建号**：`createWebPairing`（`src/ingress/admin/clients/index.ts`）在 immediate 事务里先查账号。没有账号时建一个 `admin`（`password_hash` 为 NULL，没有 Passkey），再签发 `web` 票据；已有唯一账号时直接复用；有多个账号时报错。CLI 输出新增 `account: { username, created }`。
- **`setup_required` 保留**：语义仍是「还没有管理员」。登录页据此进入首次登录模式，只显示一次性码表单，说明以「First sign-in.」开头，也没有「使用密码登录」按钮。如果先运行了命令再打开页面，`admin` 已经存在，会看到普通登录页，点「Sign in with a one-time code」即可。
- **后续设置**：登录后在 Settings 的「管理员凭据」设置用户名和密码（`POST /auth/credentials` 不要求旧密码），配置了 `public_url` 时还可以加 Passkey。`admin-account` 仍是离线建号和恢复的路径。
- **`admin:dev:mock`**：启动时通过测试钩子跑真实的 `pairing create --web --ttl-seconds 3600`，并打印 `ADMIN_DEV_MOCK_CODE pwp_…`。
- **AGENTS.md**：在 Security 不变量里写明「没有匿名建号端点」和「一次性码分两种用途、互不串用」。

### 测试迁移

先写新行为的测试，再改实现：

- `test/admin/auth.test.ts` 第一个用例：全新实例上匿名请求 `auth/setup` 返回 401，`admin_users` 仍为空；`createWebPairing` 建出 `admin`，用码登录后 session 为 `username: 'admin'`、`has_password: false`。
- `test/pairing/web-login.test.ts`：
  - 第一个码建出 `admin`，第二个码复用它；
  - 无密码的 `admin` 用密码登录返回 401；
  - 用码登录成功；
  - 往数据库多插一个账号后，CLI 拒绝签发。
- 约 30 个测试文件原来用 `/api/auth/setup` 建管理员。现在改用新的 `test/fixtures/admin-account.ts`（`createAdminAccount`，走 `admin-account` 那条路径）建号，再走真实的 `POST /api/auth/login`。`setupAdmin`、`login`、`setupAdminSession` 这几个 helper 多了 `store` 参数，调用方一并修改。原来调 `createFirstUser` 的测试改为 `createOrResetAccount` 加 `login`，原本建出的那个 Session 照样保留。
- `test/playground/only.test.ts` 跑的是真实 `serve`，改为用真实 CLI 生成的码登录。文件因此超过 5,000 token 的提交上限，于是把模型 fixture、端口探测和登录 helper 拆到 `test/playground/only-fixtures.ts`。另外，这个用例原来在 Bot 回复可见之后就立刻断言 Invocation 已 `completed`；高负载下回复和完成之间有时间差，第一次跑受影响套件时因此失败，现在改成轮询。
- E2E：
  - `00-auth` 第一个用例改为：匿名 setup 返回 401 → 只显示首次登录表单 → 真实 CLI 生成码，`account.created` 为 true → 进入 shell，身份是无密码的 `admin` → 在 Settings 改成测试用户名和密码 → 后续用例照常用密码登录。
  - 其他套件的 helper 改为先调 `/__e2e/ensure-admin`。这个钩子用 `admin-account` 的方式建号，已有账号时什么也不做。
  - `30-dev-mock` 从命令输出里读出码，再从普通登录页的一次性码入口登录。

### 验证

```bash
pnpm run lint && pnpm run check
# exit 0
npx vitest run test/admin test/pairing test/playground/only.test.ts test/replay test/cli test/prompts test/alarm test/recurring-alarms test/dictionary test/image/admin-server.test.ts test/web-search test/mcp
# 129 files passed / 2 failed：croner 路径（已知），以及 playground/only 的完成状态竞态（已改为轮询，单独复跑通过）
pnpm run admin:build && pnpm run admin:test:e2e
# 第一轮 321 passed / 3 failed，失败中有 Windows ERR_NO_BUFFER_SPACE 套接字耗尽和 30-dev-mock（流程顺序问题，已修）
# 修复后 00-auth + 30-dev-mock 9 passed；完整套件 327 passed
DOCS_BASE_PATH=/ 与 /surowan/ 各跑 docs:build + docs:verify
# 两次都 Verified 53 HTML/Markdown pages ... 173 HTTP resources
pnpm test
# 394 files passed / 2 failed / 1 skipped；1948 passed / 2 failed / 9 skipped
npx vitest run test/playground/only.test.ts test/playground/only-serve.test.ts
# 拆分文件后 2 files / 5 passed
```

全量 `pnpm test` 的两个失败都与本次改动无关：

- croner 导入路径的 Windows 反斜杠断言，已知问题；
- `test/group-memory/store.test.ts` 的关键词搜索用例。本分支没有改动 group-memory，单独复跑 9 个用例全部通过，判断是满负载下的时序问题。

未执行：

- 真实全新部署（官方 Docker 镜像）上「打开页面 → SSH 生成码 → 首次登录 → 设置凭据」的人工验收。
- 拆分 `only.test.ts` 之后没有再跑一遍全量 `pnpm test`，只复跑了 playground-only 的两个文件。

## 提交

```txt
b10f356d Sign in to the Admin Panel with one-time pairing codes
580fe8ac Show the docker compose sign-in command on the official image
b0630424 Make the first Admin Panel sign-in a one-time code from the server
```
