# Surowan - 20261102 surowan-utils 对齐 Admin Panel 能力

## 背景

`surowan-utils` 只能看、不能改。根因不是命令没写，而是服务端的授权面：面板的 `/api` 写入路由全部要求 `plasticwan_admin` Session Cookie，而 CLI 只会发 `Authorization: Bearer pwk_…`，落进 `src/ingress/admin/inspection.ts` 的固定 allowlist —— 只读检查视图与 Invocation 读/重放，其余一律 403。于是「在面板里改配置」这件事在 CLI 侧没有任何合法路径。

用户的要求是能力对齐，且明确要求配置修改在 Skill 里强调先跟用户确认。这带来三个约束：

- **不能扩 API key 的权限面**。密钥是长期凭据，把写权限塞给它等于让一把可能泄在日志里的 token 变成全权。
- **不能新增服务端端点**。面板已有的路由就是契约，CLI 应当复用，否则两边会漂移。
- **确认必须是可执行的，不只是文档措辞**。Agent 会照着 Skill 干活，机械闸门和书面规则要同时存在。

## 主要变更

### 1. 第二种凭据：面板 Session

`login --username <name>` 走 `POST /api/auth/login`，从 `set-cookie` 里取出 Session Token 存进同一个 `credentials.json`（`packages/cli/src/panel/login.ts:25`）。文件仍然只保存一份凭据，两种形状互斥：

```ts
// packages/cli/src/credentials.ts:202
function storedDocument(endpoint: string, credentials: Credentials): Record<string, string> {
  const hasApiKey = credentials.apiKey !== undefined;
  const hasSession = credentials.session !== undefined;
  if (hasApiKey === hasSession) {
    throw usageError('invalid_credentials', 'credentials must hold exactly one of an API key or a session token');
  }
  ...
}
```

请求侧关键一点：Session 必须以 Cookie 头发送，不能混进 `Authorization`。服务端只要看到 `Authorization` 就固定路由到 API-key 分支且**不回退**到 Cookie（`src/ingress/admin/index.ts` 的 `#api`），混着发会得到一个权限更小的身份，而不是两者的并集。`AdminClient` 因此按凭据种类二选一（`packages/cli/src/client.ts` 的 `#authHeaders`），且两者同时给出时在解析阶段就拒绝（`packages/cli/src/args/index.ts:111`，`conflicting_credentials`）。

`setup` 与 `session show` 是仅有的免凭据面板命令（首次建号与「是否还需建号」），由 `isPreSessionCommand` 放行（`packages/cli/src/args/index.ts:144`）；客户端在无凭据时发出不带认证头的请求，其余路由自然得到 401。

### 2. 面板路由变成可审计的数据表

`packages/cli/src/panel/specs/` 里每条 `EndpointSpec`（`packages/cli/src/panel/types.ts:47`）对应一条面板 `/api` 路由：method、带 `:param` 的 path、位置参数、可转发的 query flag、body 形态、`If-Match` 来源、`destructive`/`paid` 标记、响应是 JSON/二进制/文本。`PANEL_SPECS` 汇总为 128 行（`packages/cli/src/panel/specs/index.ts:21`），`surowan-utils commands` 原样输出。这条设计约束写进了 `agent-doc/admin-panel.md`：新增面板路由必须同时加一行，否则该能力在 CLI 里不存在。

覆盖结果是 89/89 条非 WebAuthn 面板路由，外加 13 条 Playground 路由。WebAuthn 那 4 条（passkey 注册/登录的 options/verify）刻意不做：它们需要浏览器的 authenticator，CLI 无法完成，README 与 Skill 都写明了这一点，而不是留一个会失败的命令。

命令与第一类命令的命名有重叠（`config show` vs `config apply`、`prompt get` vs `prompt save`），解析时面板表优先（`packages/cli/src/args/commands.ts`）：命中表就走面板，未命中才回落到原有 switch，因此老命令行为不变，`prompt save` 又能路由到面板行。

### 3. 写入自己解析乐观锁

面板前端把「打开表单时的 revision」放进 `If-Match`；CLI 没有表单，所以每次写入在发请求前现读：

```ts
// packages/cli/src/panel/run.ts:141
async function resolveRevision(spec, command, client): Promise<string | undefined> {
  const kind = spec.revision;
  if (kind === undefined) { ... }
  if (command.ifMatch !== undefined) {
    return command.ifMatch;
  }
  if (kind === 'entry') {
    throw usageError('if_match_required', `${spec.command} needs --if-match <revision> from the entry you read; ...`);
  }
  if (kind === 'config') {
    return await configRevision(client);
  }
  return await promptRevision(client, spec, command);
}
```

配置写入读 `GET /api/providers` 的 `revision`（`packages/cli/src/panel/run.ts:169`），Prompt 写入读该 scope 的 `content_hash`（`prompt restore` 先读版本的 scope，再取对应 Prompt 的哈希，`packages/cli/src/panel/run.ts:182`）。字典词条的 revision 只存在于调用方上一次读取结果里，无法猜测，因此要求显式 `--if-match`。冲突码 `config_conflict`/`prompt_conflict`/`dictionary_conflict` 原样透出，不重试、不覆盖。

`--if-match` 在 dry-run 里也从不自动补：`--dry-run` 完全不发请求，连 revision 查询都省掉，预览里用 `if_match_source` 说明真正执行时会读哪一种。

### 4. 机械闸门与「确认」分开

`destructive` 与 `paid` 的路由缺少 `--yes` 时，解析阶段就以 `confirmation_required`（退出码 2）拒绝，请求一个字节都不会发出；`--dry-run` 不需要 `--yes`，输出 `{method, path, if_match, if_match_source, body}` 供人核对。128 条命令里 26 条带标记。

但这只是闸门。真正的授权规则写在 Skill 里（`skills/surowan-utils/SKILL.md:36` 的「写操作的授权边界」与 `skills/surowan-utils/references/panel.md`）：写入要说明目标、字段与值、影响范围（热应用还是待重启、是否影响运行中的 Invocation）和可撤销性，破坏性操作要逐项列出后果（删除 Chat 会连带删除 Memo、Blob 与 Invocation 审计），计费操作要覆盖目标与次数。文档明确写了「不要把补 `--yes` 当成确认」。

### 5. Session 轮换必须写回

`account update`、`password delete`、`setup` 成功后服务端撤销该账号全部 Session 并签发新 Cookie。CLI 若不接管新 token，下一次命令就是 401 且用户没有任何线索。因此这类路由带 `session: 'save'`，执行后从 `set-cookie` 取出新 token 写回凭据文件；`logout` 带 `session: 'clear'`，成功后删除凭据文件（`packages/cli/src/panel/run.ts:85`）。服务端没回新 token 时报 `invalid_response`，因为旧的一定已经失效，静默保留只会制造更难查的故障。

### 6. Body 形态与 stdin

统一三种输入：`--set k=v`（字符串，支持 `a.b` 嵌套）、`--set-json k=<json>`（任意 JSON）、`--body <json>` / `--file <path|->`（整份文档）。`--file -` 从 stdin 读到 EOF，因此密码、token、prompt 不会进进程参数和 shell 历史。Prompt 编辑是例外：`prompt save --file` 按**原始 Markdown** 读入 `prompt` 字段，而不是要求先包一层 JSON（`fileField`，`packages/cli/src/panel/types.ts:66`），可同时 `--set note=…`。

`README` 的首建号示例因此长这样：

```bash
printf '{"username":"owner","password":"%s"}' "$PANEL_PASSWORD" \
  | surowan-utils setup --endpoint https://panel.example.com/ --file - --json
```

### 7. 测试与文档

- `test/cli/panel-parity.test.ts` 起真实 `AdminServer`（真实 SQLite、真实 `config.jsonc`、真实 `ConfigReloader`），用 loopback HTTP 把它套起来，再以子进程跑真实 CLI 二进制 —— 因为 CLI 是独立进程，必须真的走 HTTP 才能证明 Cookie、`If-Match`、`set-cookie` 解析都对。10 个用例覆盖：免凭据建号与 `session show`、面板密码登录写 `{endpoint,session}`、Session 读仅面板可见的审计页、`harness update` 自动读 revision 并把 `"history_messages": 17` 落到文件、破坏性与计费命令缺 `--yes` 时不发请求、`--dry-run` 零请求、API key 读面板路由得 403 而 `models list` 仍可用、`commands` 表带 `revision` 标记、改密后新 token 生效且旧 token 失效、`logout` 删文件、Playground 建房发消息、Memo 增改删、字典导出文本（`--json` 下是 JSON 字符串）、`prompt save --file -` 写原始 Markdown。
- 既有的 `test/cli/*` 只改了三处被这次契约变更影响的断言：`credential_sources` 的键从 `api_key` 改成 `credential`、登录成功文档多了 `credential` 字段、错误码 `missing_api_key` 改成 `missing_credential`（凭据不再只有 key 一种）。
- 文档：`packages/cli/README.md` 与 `REFERENCE.md`（两种凭据、写入契约、`--set/--file/--if-match/--yes/--dry-run`、Session 轮换）、`packages/cli/AGENT-SKILL.md`、`skills/surowan-utils`（入口 + 新增 `references/panel.md`）、`agent-doc/admin-panel.md` 新增「CLI 与面板能力对齐」、`agent-doc/operations.md`、`agent-doc/verification.md` 新增测试行、用户文档 `apps/docs/content/docs/reference/cli-surowan-utils*.md` 三页。

## 验证

```bash
pnpm test
# 352 passed | 1 skipped（353 个测试文件）；1965 passed | 8 skipped（1973 个用例）

# rebase 到 develop（feature/invocation-model-filter 已合入）后复跑受影响范围
pnpm test test/cli test/invocations test/npm-release.test.ts
# 25 files，193 passed | 6 skipped

pnpm run lint
# biome lint + format 通过（1189 / 1186 个文件）

pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, search, examples, schema, provenance and 116 HTTP resources (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, ... 116 HTTP resources (base /surowan/)

git diff --check
# 无输出
```

构建产物冒烟（`node packages/cli/dist/bin.js`，实际输出）：

```txt
surowan-utils commands --json     # 128 行，其中 26 条带 destructive/paid

surowan-utils chat delete 123 --json
{"error":"confirmation_required","message":"chat delete is destructive; re-run with --yes to proceed (or --dry-run to inspect the request)"}
# exit 2

surowan-utils prompt save bogus --set prompt=x --json
{"error":"invalid_scope","message":"scope must be one of global, group"}
# exit 2

surowan-utils chat delete 123 --dry-run --session <token> --endpoint http://127.0.0.1:1 --json
{"method":"DELETE","path":"/api/chats/123","if_match":null,"if_match_source":"config","body":null}
# exit 0，且 127.0.0.1:1 上没有任何监听也能成功 —— 说明 dry-run 确实不发请求
```

CI（PR #49）：`verify (root, /)` 56s、`verify (subpath, /surowan/)` 1m19s、`image-smoke` 1m51s，三项通过，`mergeStateStatus: CLEAN`。

未执行：真实 Telegram/Provider 调用。`provider health-check`、`image generation`、`room release`、Invocation replay 在测试里只覆盖了「被拒绝」与「短路」路径；它们的请求体来自同一张路由表，但没有端到端跑过一次计费操作。

## 已知限制

- Passkey 注册与登录不在 CLI 里，需要浏览器 WebAuthn authenticator；`passkey list` / `passkey delete` 可用。
- 字典词条写入必须显式 `--if-match`：revision 只存在于调用方上次读取里，CLI 没有面板那种「打开表单」的时点。
- 面板的本地偏好（主题、语言、是否显示 config.jsonc 键名）只存在浏览器 `localStorage`，没有对应接口。
- `chat group-memory` 不是 `--yes` 项（面板也不弹确认），但切换 `enabled` 会 fence 该 Chat 的全部 Conversation、中止运行中的 Invocation 并重建 Context，Skill 要求确认时说明这一点。

## 提交

```txt
656adec Add admin panel parity to the surowan-utils CLI
```
