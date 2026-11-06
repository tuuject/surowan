# @tuuject/surowan-utils

Surowan Admin Panel 与 Admin API 的工具客户端，包内命令为 `surowan-utils`。它是 monorepo 工作区包（仓库根与其它 workspace 仍为 private），已配置为可公开发布到 npm。

只接受一种凭据：在面板 **Manage → API keys** 创建并选择权限模式的 API key（`pwk_…`）。模式四选一：

| 模式 | 权限 |
| --- | --- |
| 只读 | 全部审计读取、配置/Prompt 脱敏视图、模型列表、Invocation 查询/媒体导出/重放预检 |
| 读 + 改 | 只读 + 配置、Chat、Prompt、Memo Pad、辞典、群聊记忆、告警、Playground 输入等写操作 |
| 读 + 耗 | 只读 + 重放、Provider 健康检查、生图、辞典合并预览、Playground Release/Retry 等计费操作 |
| 全部 | 以上全部；`write+paid` 操作需要这一档 |

“面板里能做的事，`surowan-utils` 里也能做”（账号与 API key 管理除外）：`surowan-utils commands` 列出全部面板命令，`--help` 给出分组概览。第一类命令（Invocation 查询/媒体导出/重放、`config show`、`prompt get`、`models list`、`login`、`doctor`）保持原有行为不变。

它与服务端入口 `surowan`（`node src/cli.ts`）不是同一个程序：本客户端只通过 Admin API 访问运行中的面板，不包含 `serve`、`check-config`、`backup`、`configure` 等服务命令；客户端自己的 `doctor` 也不执行服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针，只检查连通、鉴权与当前 key 权限。

配套 Agent Skill 的安装与用法见 [AGENT-SKILL.md](./AGENT-SKILL.md)；支持 MCP 的 Harness 也可以直接使用 [MCP Server](../apps/docs/content/docs/configure/mcp-server.md) 与 `surowan-mcp` Skill。

## 安装

发布可用后从 npm 全局安装（Node.js ≥ 24，无额外运行时依赖；命令名为 `surowan-utils`）：

```bash
npm install -g @tuuject/surowan-utils           # 稳定版，dist-tag latest
npm install -g @tuuject/surowan-utils@canary    # main 分支的 canary 构建
surowan-utils --help
```

canary 版本号形如 `0.0.0-canary.<run>.<attempt>.g<sha12>`。默认安装使用 `latest`；workflow 只把 canary 发布到独立的 `canary` 标签，不移动 `latest`，因此试用时须显式指定 `@canary`。

发布产物是单个自包含的 `dist/bin.js`（esbuild 打包），manifest 里没有任何 `dependencies`，`npm` / `pnpm` / `bun` / `yarn` 全局安装都不需要额外解析。内部包 `@surowan/admin-surface` 已编译进该文件，不单独发布。

若在 bun 上看到 `GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404`，说明装到的是旧产物（≤ `0.0.0-canary.44.1`）：那些版本把该包名写进了发布 manifest，bun 会绕过 tarball 内的副本去 registry 解析。改用更新的 canary 即可。

registry 上还没有该包（`npm install` 返回 404）或需要离线安装时，从源码检出打包后本地安装：

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-surowan-utils-0.1.0.tgz   # 文件名以实际版本为准
```

不全局安装时，可在源码仓库内运行 `node packages/cli/dist/bin.js …`（先 `pnpm cli:build`）。

包以单个自包含的 ESM 文件分发（`esbuild --bundle`），没有运行时依赖（只用标准库 `node:util` parseArgs 与全局 `fetch`）。源码内的相对导入带 `.ts` 后缀，打包后已内联，因此 `node_modules` 内不会出现 Node type stripping 拒绝的 `.ts` 文件，也不会留下指向其他 workspace 包的 `import`。

## 用法

### 使用 API key

```bash
# 由操作员在本机保存凭据；key 只经 stdin 进入，不出现在进程参数或 shell 历史
printf '%s' "$SECRET_KEY" | surowan-utils login --endpoint https://panel.example.com/ --api-key-stdin --json
# 或 surowan-utils login --endpoint https://panel.example.com/ --api-key "$SECRET_KEY" --json

surowan-utils doctor --json          # 退出码 0 且 status=ok 才继续；输出 mode/permissions
surowan-utils commands               # 列出全部面板命令
```

`doctor` 的 `--json` 输出里 `credential` 恒为 `api_key`，`mode`/`permissions` 是当前密钥权限，`credential_sources.credential` 说明它来自参数、环境变量还是文件。凭据文件只保存 `{endpoint, apiKey}`；旧的 `session` 字段不再被读取。

面板命令的通用形态：

```bash
# 读取
surowan-utils harness show --json
surowan-utils chat list --json
surowan-utils memo list --chat -1001234567890 --json

# 写入（需要 read_write 或 all）：body 由 --set / --set-json / --body / --file 组成
surowan-utils harness update --set-json values.history_messages=40 --json
surowan-utils chat create --set id=-1009876543210 --set-json topic_ids=null --set-json provider=null --set-json model=null --set-json thinking_level=null --json
surowan-utils memo create --set chat_id=-1001234567890 --set summary=偏好 --set detail=细节 --set-json ttl_seconds=null --json
surowan-utils prompt save global --file prompt.md --set note='更简短' --json   # --file 读原始 Markdown

# 破坏性或计费操作：缺少 --yes 时在发请求前以 confirmation_required（退出码 2）拒绝
surowan-utils chat delete -1009876543210 --yes --json
surowan-utils telegram token clear --yes --json
surowan-utils provider health-check --set provider=openrouter --set model=deepseek/deepseek-v4-flash-0731 --yes --json
surowan-utils invocation replay 12345 --yes --json

# 先看清楚会发什么，再决定
surowan-utils chat delete -1009876543210 --dry-run --json
```

`If-Match` 的取法：写入命令默认在发请求前读取当前 revision（配置写入读 `GET /api/providers` 的 `revision`，Prompt 写入读该 scope 的 `content_hash`），所以不必手工搬运；`--if-match <值>` 用于显式钉住一份旧快照，字典词条与 Memo/群聊记忆的 revision 只能由调用方从上次读取中给出。配置在两步之间被别人改过时，服务端返回 `config_conflict`/`prompt_conflict`，文件不会被覆盖。

账号、密码、Passkey 与 API key 管理不在 CLI 内：这些只能由浏览器面板或服务端 `surowan` CLI 完成。权限不足时请求返回 `403 forbidden`；请操作员在面板修改 key 模式，不要寻找绕过。

### 只读检查与重放

只读模式（`read`）即可执行以下命令；重放需要 `read_paid` 或 `all`：

```bash
surowan-utils config show --json
surowan-utils config show --source file --json
surowan-utils prompt get global --json
surowan-utils prompt get group --chat -1001234567890 --source file --json
surowan-utils models list --json
surowan-utils invocation prompts 12345 --json
surowan-utils invocation preflight 12345 --json

surowan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
surowan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
surowan-utils invocation list --model deepseek/deepseek-v4-flash --from '2026-09-10 07:00' --to '2026-09-11 07:00' --json
surowan-utils invocation get 12345 --json
surowan-utils invocation media 12345 --json
surowan-utils invocation replay 12345 --json
surowan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | surowan-utils invocation replay 12345 --global-prompt - --json
surowan-utils invocation replay 12345 --group-prompt group.txt --json
surowan-utils invocation preflight 12345 --before-send 678 --json
surowan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
surowan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
surowan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
```

无人值守或 CI 环境改用已注入的环境变量，或让 key 只经标准输入进入：

```bash
# endpoint 与 key 已在环境变量里；login 读取它们并写入凭据文件
surowan-utils login --endpoint "$SUROWAN_ENDPOINT" --json

# 或让 key 只经标准输入进入：读到 EOF 才停，累计不超过 4098 字节
printf '%s' "$SECRET_KEY" | surowan-utils login --endpoint "$SUROWAN_ENDPOINT" --api-key-stdin --json
```

不要手动 `export` 明文 key：含明文 key 的 `export` 会进入 shell 历史。

`login` 把 endpoint 与 key 成对保存到固定路径 `~/.config/surowan-utils/credentials.json`（所有平台一致；与 Bot 的 `config.jsonc`、`key.json` 无关，同一时间只保留最近一次 `login` 的一对）。文件是 JSON 对象，字段为 `endpoint` 与 `apiKey`，**未加密**；POSIX 上目录 `0700`、文件 `0600`（更窄的权限同样接受），Windows 不做 POSIX mode 检查、权限由用户目录 ACL 继承（工具不承诺 `chmod` 级别的保护）。既有文件是符号链接、不是普通文件或权限不安全时，读写都拒绝且**不自动修复或替换**，需人工处理。`login` 不访问服务器，也不读取旧凭据内容；保存成功不代表在线鉴权通过，请接着运行 `doctor`。序列化后的凭据超过 16384 字节会被拒绝（`credentials_too_large`，退出码 2）且不触碰旧文件；写入经同目录临时文件 `rename` 落地，任何失败都不会覆盖旧文件。

凭据解析顺序（`doctor`、`config show`、`prompt get`、`models list` 与 `invocation list/get/prompts/preflight/media/replay` 相同）：命令行参数 > 环境变量 > 保存文件。参数或环境变量显式给出的空串（含只含空白的 endpoint）按缺失/非法处理，**不会回退**到下一来源或改为提示（解析命令报 `missing_endpoint`/`missing_credential`，`login` 报 `invalid_endpoint`/`invalid_api_key`）。endpoint 与 key 都由参数或环境变量明确给出时完全不读取凭据文件，文件损坏、是符号链接或权限不安全都不影响这次调用；只给其一才读文件，此时文件本身的问题以 `invalid_credentials` 失败（退出码 1）。保存的 key 只属于它保存时的规范化 endpoint：当前 endpoint 与文件中的 endpoint 在 `parseEndpoint` 规范化后不一致（例如换了主机）就不会使用该 key，缺少显式 key 会以 `missing_credential` 失败（退出码 2），更换服务必须同时显式提供 key 或重新 `login`；规范化后相同（如仅尾斜杠差异）则仍可使用。参数与环境变量不会被写回文件（只有 `login` 写文件）。`login --json` 输出 `{"status":"saved","endpoint":…,"credentials_file":…}`，不含 key；`endpoint` 是规范化后的基地址。

`doctor` 按同一顺序解析凭据后先 `GET /api/key` 读取权限，再发起一次 `GET /api/invocations?limit=1`——没有 replay、没有模型/Provider 调用，也不发送 Telegram 消息；`--json` 成功时 stdout 为 `{"status":"ok","endpoint":…,"credential":"api_key","mode":…,"permissions":{…},"credential_sources":{"endpoint":"argument|environment|file","credential":…}}`，不输出 Invocation 正文，失败不自动重试；鉴权仍会在服务端更新该密钥的 `last_used_at`。失败时 stderr 为 `{"error","message"}`：参数/环境变量给出的凭据缺失或不合法（`missing_endpoint`、`missing_credential`、`invalid_api_key` 等）退出码 `2`，保存文件无效（`invalid_credentials`）或请求失败退出码 `1`。

### 选项

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `SUROWAN_ENDPOINT` | Admin Panel 基地址；解析顺序为参数 > 环境变量 > `login` 保存的凭据文件，三处都没有时按缺失报错，显式空串或纯空白按缺失报错（`missing_endpoint`）、不回退。明文 `http` 仅允许 loopback（`127.0.0.0/8`、`::1`、`localhost`）；远端必须 `https`；禁止 URL 内凭据、query 与 fragment；保存与比较都用 `parseEndpoint` 规范化后的 URL（trim、补尾斜杠、去默认端口） |
| `--api-key <key>` / `SUROWAN_API_KEY` | API key：1–4096 字符，不得含空白或控制字符（参数/环境变量报 `invalid_api_key`，保存文件内的非法值报 `invalid_credentials`）；与 endpoint 同一解析顺序，命令行参数优先于环境变量，显式空串不回退。仅当解析出的 endpoint 与文件 endpoint 规范化后相同才使用文件中的 key，否则缺少显式 key 报 `missing_credential` |
| `--api-key-stdin` | 仅 `login`：把标准输入读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，剩余换行、空白或控制字符整体非法（`invalid_api_key`，退出码 2）；TTY 上拒绝；整次读取受 `--timeout-ms` 约束，超时 `timeout`（退出码 1）且不保存；不能与 `--api-key` 或 `SUROWAN_API_KEY` 同时给出；不是 `--api-key -`，其它子命令不从标准输入读取 key |
| `--source <active\|file>` | 仅 `config show` 与 `prompt get`：`active`（默认）读运行中的配置快照，`file` 读磁盘上的配置文件并可与 active 对比；其它子命令带 `--source` 报 `unexpected_option`。两者不会互相替代，`file` 需要服务端已接线配置加载 |
| `--set key=value` / `--set-json key=<json>` | 面板命令：设置 body 字段；`--set` 只收字符串，`--set-json` 收任意 JSON（`null`、数组、对象、数字、布尔）。键支持 `a.b` 嵌套；同一键重复设置报 `invalid_set` |
| `--body <json>` / `--file <path>` | 面板命令：整份 body 文档；与 `--set`/`--set-json` 互斥（`conflicting_body`）。`prompt save` 是例外：`--file` 按**原始文档**读取并填入 `prompt` 字段，可同时用 `--set note=…`。`--file -` 从标准输入读到 EOF（TTY 上拒绝），用来传密码、token 或 prompt 而不进 shell 历史；上限 1 MiB，读取失败报 `body_file_unreadable` |
| `--if-match <revision>` | 面板命令：显式指定 `If-Match`。省略时配置写入自动读取当前 `revision`，Prompt 写入自动读取该 scope 的 `content_hash`；字典词条写入必须显式给出（`if_match_required`） |
| `--yes` | 面板命令：确认破坏性（`destructive`）或计费（`paid`）操作；缺失时在发请求前以 `confirmation_required`（退出码 2）拒绝。`--dry-run` 可替代它用于预览 |
| `--dry-run` | 面板命令：只把将要发送的 `method`/`path`/`if_match`/`body` 写到 stdout，不发请求 |
| `--output <path>` | 面板命令：把二进制（图片、媒体）或文本（字典导出）响应写入文件，并输出 `{status,path,bytes}`；JSON 响应的命令带该选项时在发请求前以 `unexpected_option`（退出码 2）拒绝 |
| `--variant <original\|preview>` | 仅 `invocation media`：下载原始文件（默认）或服务端规范化预览；preview 只对 photo/sticker 可用，单文件与总量上限见下文 |
| `--timeout-ms <ms>` | 请求/输入超时；默认除 replay（300s）外都是 30s。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时会中止请求，均**不自动重试** |
| `--json` | 稳定 JSON 输出；成功时 stdout 恰好一个 JSON 文档 |
| `--limit` / `--cursor` / `--state` | 透传给 `GET /api/invocations` 的过滤参数，本地先做形状校验（limit 1–100；Invocation ID/cursor 为非负十进制，限制在有符号 64 位范围） |
| `--chat <id>` | `invocation list` 的 Chat 过滤，或 `prompt get group` 必填的群 ID；必须是可带负号的有符号 64 位十进制，缺失时 `prompt get group` 报 `missing_argument` |
| `--search <keyword>` | 仅 `invocation list`：按字面关键词匹配公开消息（1–100 字符；`%`、`_` 按字面处理）。候选是冻结 `invocation_messages`（`section=new`）的群友消息 text/caption，或同 Invocation 成功 `telegram_sends` 的 text/caption；与时间过滤同用时关键词与时间必须命中同一条消息。带搜索或时间过滤时每个 item 追加 `matched_messages`，不带时维持原形状 |
| `--at <time>` / `--from <time>` / `--to <time>` | 仅 `invocation list`：公开消息时间过滤。`--at` 命中写出的整个精度窗口（`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数 1/2/3 位分别对应 100/10/1 毫秒窗口），`--from`/`--to` 组成半开区间 `[from, to)`；`--at` 不能与 `--from`/`--to` 同用。格式 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z\|±HH:mm]`；不带 offset 的时间在服务端按 `--chat` 对应 Chat 的时区解析、否则用全局时区，非法日历与 DST 不存在/重复时间被拒绝 |
| `--before-send <send-id>` | 仅 `invocation preflight` 与 `invocation replay`：以该 `telegram_sends` 内部 ID（必须是本 Invocation 的成功发送）作为切片边界；preflight 与 replay 必须使用同一选择 |
| `--confirm-paid` | 仅 `invocation replay`：切片重放（`--before-send`）需显式确认真实模型计费；缺失时以 `confirm_paid_required`、退出码 2 拒绝，不读 prompt 或 stdin，也不发预检或 POST。未切片重放不要求该 flag |
| `--global-prompt <file\|->` | 仅 replay：临时替换 global prompt 层；`-` 从非终端标准输入读取，去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 2 失败 |
| `--group-prompt <file\|->` | 仅 replay：临时替换 group 层；允许空内容以显式清空该层，最多 65,536 字符；与 `--global-prompt -` 不能同时从 stdin 读取（`conflicting_prompt_input`）。标准输入只用于 `login` 的 key 与 replay 的 prompt |
| `--provider <alias>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的 Provider alias；必须与 `--model` 成对（`invalid_model_override`，退出码 2），1–256 字符、不含控制字符 |
| `--model <id>` | `invocation list`：按该 Invocation 的 **agent** `model_calls.model` 精确过滤（区分大小写，不做前缀/模糊匹配；视觉与 Tool Model 调用不算），1–256 字符、不含控制字符，空值、纯空白或其它非法值以 `invalid_model`（退出码 2）拒绝；list 不接受 `--provider`/`--thinking-level`。`invocation preflight` 与 `invocation replay`：临时模型覆盖的模型 ID，必须与 `--provider` 成对，规则同上 |
| `--thinking-level <level>` | 仅 `invocation preflight` 与 `invocation replay`：临时 thinking 覆盖，取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（`invalid_thinking_level`，退出码 2）。可单独使用（只临时改 thinking，模型沿用当前 Chat 配置）；与模型对同给时按该模型校验级别，给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），模型不支持的级别由服务端拒绝。预检与重放必须使用同一选择 |

完整 API 契约、输出与退出码见 [REFERENCE.md](./REFERENCE.md)。

维护者发布流程见 [RELEASING.md](./RELEASING.md)。
