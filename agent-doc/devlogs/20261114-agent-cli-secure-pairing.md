# Surowan - 20261114 Agent CLI 安全配对与签名凭据

## 背景

目标是让通用 Coding Agent 通过 SSH 部署塑料碗之后，用 `surowan-utils` 继续管理实例，而不让任何长期凭据进入 LLM 上下文。改动前 CLI 只认 `pwk_…` Bearer API key：要么用户把 key 粘贴给 Agent，要么 Agent 自己从服务端读出来再交给 `login`，两种方式都会让长期秘密进入对话、工具调用记录或日志。

用户给的 PRD 留了几个技术决策待定，这次实施时定了下来：

- 签名用 Ed25519，两端都不引入新依赖。服务端验签只用 WebCrypto，给以后迁到 Cloudflare Workers 留路。
- 配对码由服务端创建，可以预绑定公钥。不做客户端发起、管理员再 `approve` 的待审队列，避免多开一个能匿名写库的入口。
- 本机凭据存在受限权限文件里，不用系统 Keychain。
- 新建表，但复用 API key 的四种模式和 admin-surface 的同一道权限闸门。
- 这轮不做面板页面、不做密钥轮换、不做地址自动发现。

实现经 T3 Code 派给 Pi（`magpie/opencode-go/deepseek-v4.1-flash`）完成。主会话负责 `ocr review`、逐条核实、打回修正两轮、拆分超限文件，最后独立复验并提交。

## 主要变更

### 1. 配对码与数据层

迁移 `058_admin_clients.sql` 新增三张表：

- `admin_clients`：已配对客户端，带公钥、指纹和与 API key 相同的三个权限布尔值。部分唯一索引保证同一把公钥只能有一个未撤销的客户端；撤销的行保留。
- `admin_pairings`：一次性配对票据，只存 `pwp_` 码的 SHA-256 摘要，可选预绑公钥。
- `admin_client_nonces`：持久化的已用 nonce。

实例 id 存在 `app_state.admin_instance_id`，签名会绑定它。`purgeExpiredData` 负责清理过期 nonce 和超过保留期的已失效票据。

服务端 CLI 新增 `pairing create|list|cancel` 和 `clients list|revoke`（`src/ingress/admin/clients/cli.ts`）。这组命令不拿 `ServeLock`，可以和运行中的 `serve` 共存：

- 不做迁移；数据库文件不存在或迁移 058 未应用时直接报错，提示先启动 `serve`（`cli.ts:39`），不会顺手建出一个空库。
- `--mode` 必须显式给出。
- `next` 提示的地址取 `public_url`，没有时取 SSH 隧道本地端的 `http://127.0.0.1:<port>/`（`cli.ts:65`）。

### 2. 签名请求与领取

`POST /api/pairing/claim` 是唯一的匿名写端点（`src/ingress/admin/clients/pairing.ts:42`）：

- 领取时要附上用待注册私钥签的 proof，只拿到配对码不足以把别人的公钥绑上来。
- 预绑公钥不匹配时不会烧掉这张码。
- 过期检查在 immediate 事务里用新读的时钟重做，消费 `UPDATE` 也带上 `expires_at > now`（`pairing.ts:134`）。

之后客户端每个请求带 `Authorization: Surowan-Signature v=1,client=…,ts=…,nonce=…,sig=…`。签名串由 `packages/admin-surface/src/signing.ts` 构造，覆盖 instance、方法、`/api/…` 目标加 query、body 的 SHA-256、时间戳和 nonce。

`authenticateClientRequest`（`src/ingress/admin/clients/signature.ts:36`）的验证顺序：

1. 解析头、查客户端、检查 ±300 秒窗口。
2. 读 body，验签。
3. 用新读的时钟再查一次窗口（`signature.ts:71`），重读客户端状态（`signature.ts:78`）。
4. 最后才记 nonce。nonce 的过期时间按请求时间戳推导（`nonceExpiresAtSeconds`，`signing.ts:33`，即 ts + 301 秒）。

验签和摘要只用 `crypto.subtle`（`src/ingress/admin/clients/keys.ts`），文件里没有 `node:` 导入；`keys.test.ts` 断言了这一点，并交叉验证 `node:crypto` 签出的签名。公钥只接受规范的 base64url 写法（`keys.ts:129`）：最后一个字符有 2 个未用比特，同一把公钥原本有 4 种写法，会绕过唯一索引。

API key 与配对客户端共用 `gateProgrammaticCredential`（`src/ingress/admin/credential-gate.ts:45`）。`GET /api/key` 多了 `kind`，客户端还多一个 `fingerprint`。`/mcp` 仍只认 Bearer。

### 3. 客户端 CLI

- 新增 `surowan-utils auth init|pair|status|permissions|logout`。
- 私钥以 PKCS#8 PEM 存在 `~/.config/surowan-utils/client-key.pem`。与 `credentials.json` 共用 `private-file.ts` 的规则：普通文件、不能是符号链接、POSIX 下文件 0600 目录 0700、错误信息里不带文件内容。
- 新建密钥用 `link` 发布，只在文件不存在时成功（`packages/cli/src/private-file.ts:107`）。并发 `auth init` 不会互相覆盖。
- `credentials.json` 改为两种精确形态二选一：`{endpoint, apiKey}` 或 `{endpoint, client_id, instance_id}`。
- `AdminClient` 按实际发送的字节签名（`packages/cli/src/client.ts:230`）。`doctor` 的 `credential` 为 `client_signature`。
- `--code` 和 `--force` 在 `auth pair` 以外的命令上一律拒绝。

### 4. 文档与 Skill

同步了以下文档：

- `AGENTS.md`、`agent-doc/admin-panel.md`（含写端点白名单）、`data-layer.md`、`operations.md`。
- `packages/cli` 的 README、REFERENCE、AGENT-SKILL。
- `skills/surowan-utils`，新增 `references/pairing.md`：Agent 可以执行 `auth init/pair/status/permissions`，仍然不能 `login`，也不能读取凭据文件。
- 用户指南新增 `apps/docs/content/docs/configure/admin-agent-pairing.md`。

Docker 写法统一为 `docker compose exec -u surowan plasticwan node /app/src/cli.ts …`。原因有两个：镜像里没有 `surowan` 可执行文件；`exec` 默认以 root 运行，可能留下 root 所有的 SQLite `-wal`/`-shm` 文件。

### 5. 审阅中修掉的问题

`ocr review` 报了 10 条，主会话自己又找出 5 条：

| 问题 | 来源 | 处理 |
| --- | --- | --- |
| 签名窗口和撤销状态在 body 到达前就判定了，慢速 body 可以绕过 | ocr | Pi 修正 |
| nonce 按收到请求的时间保留 600 秒，窗口边界有约 1 秒能重放 | 主会话 | Pi 修正 |
| claim 的过期检查用的是旧时钟 | ocr | Pi 修正 |
| 并发生成密钥会互相覆盖 | ocr | Pi 修正 |
| `auth status/permissions` 忽略显式凭据 | ocr | Pi 修正 |
| `--code` / `--force` 在其他命令上被静默忽略 | ocr | Pi 修正 |
| `WiredClient` 接口重复声明 | 主会话 | Pi 修正 |
| 公钥非规范编码 | ocr + 主会话 | 主会话修，Pi 补测试 |
| 19 位 client id 超出 int64 范围导致 500 | ocr | 主会话修，Pi 补测试 |
| 服务端 CLI 会建出空库 | 主会话 | 主会话修，Pi 补测试 |
| `next` 提示用了绑定地址 | 主会话 | 主会话修，Pi 补测试 |
| Docker 命令写法错误 | 主会话 | 主会话修文档 |

- **误报**：ocr 两次要求把配对码加进 CLI 的脱敏列表。没有采纳，因为配对码短期、一次性，按设计允许进入上下文，本来就作为命令行参数传入，服务端也从不回显它。
- **回归测试**：第一轮修正新增的 11 个回归测试，Pi 报告在修复前的代码上全部失败、修复后全部通过（主会话没有重做这项对照）。
- **文件拆分**：pre-commit 的单文件 5,000 token 上限拦下了 `src/ingress/admin/index.ts` 和回归测试文件。前者把共用权限判断拆到 `credential-gate.ts`，后者按主题拆成 `regressions-signature` 和 `regressions-cli` 两个测试文件。

## 验证

主会话在 rebase 到 `e469ba12` 之后亲自运行：

```bash
pnpm install --frozen-lockfile && pnpm --filter @surowan/admin-surface build
# exit 0
pnpm run check
# exit 0
pnpm run lint
# exit 0
pnpm run cli:build
# exit 0
git diff --check origin/develop HEAD
# exit 0
npx vitest run test/pairing test/cli test/admin test/schema test/foundation test/scene test/tasks test/skills.test.ts test/docs test/manual-pack.test.ts
# 116 files passed, 540 passed / 7 skipped
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 53 HTML/Markdown pages ... 173 HTTP resources (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 53 HTML/Markdown pages ... 173 HTTP resources (base /surowan/)
git status --porcelain
# 空
```

rebase 之前，主会话在第二轮修正后的代码上跑过完整 `pnpm test`：1935 passed / 9 skipped / 1 failed。唯一失败的是 `test/recurring-alarms/schedule.test.ts` 的 croner 导入路径断言：Windows 上 `path.relative()` 得到反斜杠。在未改动的 develop `13242bb2` 上同样失败，与本次改动无关。拆文件之后没有再跑全量。

Pi 另外报告：拆分前后 `test/admin` 51 files / 221 passed；`node scripts/file-token-limit.ts` 对暂存区 exit 0（主会话的提交钩子同样通过）。

未执行：

- POSIX 下 0600/0700 权限断言（Windows 跳过，留给 Linux CI）。
- 真实 VPS 上的 SSH 配对与 `docker compose exec -u surowan` 验收。
- 产品知识索引没有针对新增的手册页重新烘焙。

## 提交

```txt
85a977f3 Pair agent CLIs with one-time codes and signed requests
```
