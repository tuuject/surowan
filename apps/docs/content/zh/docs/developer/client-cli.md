---
title: 客户端 CLI（surowan-utils）
description: 安装 @tuuject/surowan-utils，用 API key 或已配对客户端访问 Admin API，并掌握命令、body、revision 与确认参数。
---

# 客户端 CLI（surowan-utils）

`@tuuject/surowan-utils` 是 Admin Panel 的工具客户端，命令名 `surowan-utils`。它只通过 Admin API 访问运行中的面板：不含 `serve`、`check-config`、`backup`、`configure`，自己的 `doctor` 也不做服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针。服务端命令见[服务端 CLI](service-cli.md)。

设计目标是「面板里能做的事，这里也能做」，只有账号、凭据与 API key 管理例外。

## 安装

```bash
npm install -g @tuuject/surowan-utils           # dist-tag latest
npm install -g @tuuject/surowan-utils@canary    # main 分支的 canary 构建
surowan-utils --help
```

- 要求 Node.js ≥ 24。发布产物是单个自包含的 ESM 文件，manifest 里没有运行时依赖，`npm` / `pnpm` / `bun` / `yarn` 全局安装都不需要额外解析。
- `latest` 只由维护者推送的稳定 tag 移动；canary 构建的版本号形如 `0.0.0-canary.<run>.<attempt>.g<sha12>`，试用时必须显式写 `@canary`。
- registry 上还没有该包或需要离线安装时，从源码打包后本地安装：

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-surowan-utils-0.1.0.tgz   # 文件名以实际版本为准
```

不全局安装时，可以 `pnpm cli:build` 后运行 `node packages/cli/dist/bin.js …`。

## 两种凭据

凭据文件固定是 `~/.config/surowan-utils/credentials.json`（所有平台一致，与 Bot 的 `config.jsonc`、`key.json` 无关）。它**未加密**，同一时间只保存一种：

| 形式 | 怎么来 | 文件内容 | 说明 |
| --- | --- | --- | --- |
| API key | `surowan-utils login --endpoint <url> --api-key <key>` | `{ endpoint, apiKey }` | 权限由该 key 的模式决定 |
| 已配对客户端 | `surowan-utils auth pair --endpoint <url> --code pwp_…` | `{ endpoint, client_id, instance_id }` | 每个请求用本机私钥签名 |

后写入者生效：`login` 覆盖客户端凭据，`auth pair` 覆盖 key 凭据；`login` 不会删除 `client-key.pem`。旧的 `session` 字段不再被读取。

文件规则：POSIX 上目录 `0700`、文件 `0600`（更窄也接受），Windows 不做 POSIX mode 检查、由用户目录 ACL 决定；既有文件是符号链接、不是普通文件或权限不安全时，读写都拒绝且**不自动修复**。序列化后超过 16384 字节会被拒绝。写入经同目录临时文件 `rename` 落地，失败不会覆盖旧文件。

### 凭据解析顺序

`--endpoint` / `SUROWAN_ENDPOINT` 与 `--api-key` / `SUROWAN_API_KEY` 都按 **命令行参数 > 环境变量 > 凭据文件** 解析：

- 参数或环境变量显式给出的空串（含只有空白的 endpoint）按缺失处理，**不回退**到下一个来源：`missing_endpoint`、`missing_credential`、`invalid_api_key`。
- endpoint 与 key 都由参数或环境变量明确给出时，完全不读凭据文件——文件损坏、是符号链接或权限不安全都不影响这次调用。只给其中一个才读文件，此时文件本身的问题以 `invalid_credentials` 失败。
- 保存的 key 只属于它保存时的规范化 endpoint（trim、补尾斜杠、去默认端口）。当前 endpoint 规范化后不一致就不会使用文件里的 key；一致则仍可使用。
- 明文 `http` 只允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`；URL 不能带凭据、query 或 fragment。

### 保存 API key

```bash
# 交互终端里由操作员执行；key 只经 stdin 进入，不进 argv 与 shell 历史
printf '%s' "$SECRET_KEY" | surowan-utils login --endpoint https://panel.example.com/ --api-key-stdin --json
surowan-utils login --endpoint https://panel.example.com/ --api-key "$SECRET_KEY" --json
surowan-utils login --endpoint "$SUROWAN_ENDPOINT" --json    # key 由 SUROWAN_API_KEY 注入
```

`login` 只写本机文件，不访问服务器，所以「保存成功」不等于鉴权通过。`--api-key-stdin` 把标准输入读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，其余换行或控制字符整体非法；TTY 上拒绝；整次读取受 `--timeout-ms` 约束；不能与 `--api-key` 或 `SUROWAN_API_KEY` 同时给出。

### 已配对客户端

```bash
surowan-utils auth init --json                                   # 生成/复用 client-key.pem，打印公钥与指纹
surowan-utils auth pair --endpoint https://panel.example.com/ --code pwp_… --json
surowan-utils auth status --json
surowan-utils auth permissions --json
surowan-utils auth logout --json
```

`auth pair` 领取服务器上 `surowan pairing create` 打印的一次性码（见[服务端 CLI](service-cli.md)）。客户端自己生成一对 Ed25519 密钥，私钥以 PKCS#8 PEM 存在 `~/.config/surowan-utils/client-key.pem`，与凭据文件同一套文件规则（普通文件、非符号链接、`0600`、目录 `0700`、原子写入），**永不打印、不接受参数或环境变量传入、没有导出命令**，服务端只保存公钥。

之后每个请求都带一个签名，绑定 `instance_id`、HTTP 方法、路径与 query、body 摘要、Unix 秒时间戳和一次性 nonce，服务端用 WebCrypto 验证 Ed25519 与 SHA-256，并按服务器端记录拒绝重放；时间戳超出 ±300 秒返回 `signature_clock_skew`，nonce 复用返回 `signature_replayed`（重启后仍然拒绝）。完整约定见 [HTTP 公共约定](http/index.md)。

`auth pair` 在已有凭据时以 `already_configured` 拒绝，加 `--force` 才覆盖。`auth logout` 只删本机 `credentials.json` 与 `client-key.pem`，**不撤销服务端身份**；撤销要在服务器上执行 `surowan clients revoke <client-id>`。`auth status` 在什么都没配置时退出码 0 并输出 `{"status":"not_configured",…}`。

## 专用命令

这些命令不经过通用面板命令表，各有自己的选项与输出：

| 命令 | 作用 |
| --- | --- |
| `doctor` | 一次 `GET /api/key` 读取模式与权限，再一次 `GET /api/invocations?limit=1`；不调用模型、不重放、不发 Telegram |
| `commands` | 列出全部面板命令（`--json` 时带 `method`、`path`、`revision`、`confirm`、`summary`） |
| `models list` | 当前生效配置中接受文本输入的已配置模型；不发 Provider 请求，也不构成使用授权 |
| `config show [--source active\|file]` | 脱敏后的配置视图；`active` 读运行时快照，`file` 读磁盘 |
| `prompt get global\|group --chat <id>` | 脱敏后的 Prompt 与 `content_hash` |
| `invocation list` | 审计列表，支持 `--limit`、`--offset`、`--as-of`、`--state`、`--chat`、`--model`、`--search`、`--at`、`--from`、`--to` |
| `invocation get <id>` / `prompts <id>` | 单次运行的详情，以及该场景当前使用的两层 Prompt |
| `invocation preflight <id>` | 免费预检可重放性与场景，见 [Invocation 预检与重放](replay.md) |
| `invocation media <id>` | 把快照授权的媒体下载到新建临时目录，输出含 `sha256` 的 manifest |
| `invocation replay <id>` | 真实重放，计费，不发 Telegram |

`doctor --json` 成功时输出 `{"status":"ok","endpoint":…,"credential":"api_key|client_signature","mode":…,"permissions":{…},"credential_sources":{…}}`（签名凭据另有 `client_key: "file"`）；只有退出码 `0` 才算连通与鉴权都通过。

`invocation list` 翻页时把首页响应的 `as_of` 用 `--as-of` 带回，列表就停在同一个快照，期间新产生的运行只计入 `new_count`；不带 `--as-of` 取最新快照。带 `--search` 或时间过滤时每项会多出 `matched_messages`（最新 5 条，预览最多 2000 字符）。

`invocation media` 每个文件不超过 20 MiB、单次合计不超过 100 MiB、最多 32 项；`--variant preview` 取服务端规范化预览（只对 photo/sticker 有意义）。

## 通用面板命令

任何一个面板操作都是一条命令，参数、方法与路径来自与服务端同一份接口表；生成好的 [客户端 CLI 命令目录](cli-commands.md) 逐条列出方法、路由、权限与确认要求：

```bash
surowan-utils harness show --json
surowan-utils chat list --json
surowan-utils commands --json
```

### body

| 选项 | 作用 |
| --- | --- |
| `--set key=value` | 设置字符串字段；键支持 `a.b` 嵌套；同一键重复设置报 `invalid_set` |
| `--set-json key=<json>` | 设置任意 JSON 值（`null`、数组、对象、数字、布尔） |
| `--body <json>` | 整份 body 文档，与 `--set`/`--set-json` 互斥（`conflicting_body`） |
| `--file <path>` | 从文件读整份 body；`--file -` 从标准输入读到 EOF（TTY 上拒绝），上限 1 MiB |

`prompt save` 是例外：`--file` 按**原始 Markdown** 读入并填入 `prompt` 字段，可以同时用 `--set note=…`。

### revision

写入默认在发请求前读当前 revision：配置写入读 `GET /api/providers` 的 `revision`，Prompt 写入读该 scope 的 `content_hash`，所以不必手工搬运。条目类写入（辞典词条、Memo、群聊记忆、循环闹钟 `update`）的 revision 只有调用方知道，必须用 `--if-match` 显式给出，否则以 `if_match_required`（退出码 2）拒绝。

被别处改过时服务端返回 `config_conflict` / `prompt_conflict`，不会覆盖。`--if-match` 也可以用来钉住一份旧快照做受控重试。

### 确认与预览

- 破坏性（`destructive`）与计费（`paid`）命令缺少 `--yes` 时，在**发请求前**以 `confirmation_required`（退出码 2）拒绝。
- `--dry-run` 完全不发请求，输出 `{method, path, if_match, if_match_source, body}` 供人工核对；它也能替代 `--yes`。
- `--yes` 只是机械闸门，不是授权本身：先向用户说明目标、次数与影响，再执行。

### 输出到文件

`--output <path>` 把二进制（图片、媒体）或文本（辞典导出）响应写入文件，并输出 `{status, path, bytes}`。JSON 响应的命令带这个选项会在发请求前以 `unexpected_option` 拒绝。

### 常用示例

```bash
# 入场闸门
surowan-utils decision-gate show --json
surowan-utils decision-gate update --set-json mode=shadow --set-json threshold=0.6 --json
surowan-utils decision-gate decisions --chat -1001234567890 --limit 20 --json
surowan-utils chat decision-gate -1001234567890 --set-json mode=shadow --json

# 循环闹钟（新建/改/立即执行需要 --yes：保存后会在无人值守时绕过日预算调用模型）
surowan-utils recurring-alarm list --json
surowan-utils recurring-alarm preview --set-json 'rules=["0 9 * * 1-5"]' --set time_zone=Asia/Shanghai --json
surowan-utils recurring-alarm run 3 --yes --json

# 出站 MCP 服务器；describe 用 Tool Model 起草描述（计费）
surowan-utils mcp-server list --json
surowan-utils mcp-server create --set alias=notes --set url=https://mcp.example.com/mcp \
  --set-json 'tools=["*"]' --set-json payload_max_bytes=65536 --set-json result_max_bytes=32768 --json
surowan-utils mcp-server describe notes --yes --json

# 贴纸集
surowan-utils sticker-set list --json
surowan-utils sticker-set update work --set note='工作日贴纸' --json

# 生图素材；extract 只返回建议、不写数据，但会调用模型
surowan-utils image asset update 42 --set-json agentVisible=true --json
surowan-utils image asset extract 42 --yes --json

# 失败运行的真实续跑（会发 Telegram 消息）
surowan-utils invocation resume 12345 --yes --json

# 先看清楚再发
surowan-utils chat delete -1009876543210 --dry-run --json
surowan-utils chat delete -1009876543210 --yes --json
```

命令名以 `surowan-utils commands` 为准；`--help` 给的是分组概览。

## 输出与退出码

- `--json`：stdout 恰好一个 JSON 文档。人类模式输出列表摘要或缩进 JSON。
- 失败：stderr 为 `{"error":"<code>","message":"<message>"}`，错误信息经 key 与私钥脱敏，密钥不会出现在任何输出里。
- 退出码：`0` 成功；`1` 请求、服务端、replay、媒体下载失败或凭据文件无效；`2` 参数、输入或凭据不合法（含 `missing_endpoint`、`missing_credential`、`invalid_api_key`、`invalid_model_override`、`confirmation_required`、`if_match_required`）。
- `--timeout-ms`：默认非 replay 命令 30 秒、replay 300 秒。stdin 读取单独使用同一上限。HTTP 超时会中止请求。
- 请求不跟随重定向，也**不自动重试**。JSON 响应体没有客户端大小上限，完整读取后解析，仍受超时约束。
- 标准输入只用于 `login --api-key-stdin`、`--file -` 与 replay 的 `--global-prompt -` / `--group-prompt -`（两个 prompt 不能同时从 stdin 读）。

权限不足时服务端返回 `forbidden`。请操作员在面板改 key 模式，不要寻找绕过路径；`read`、`read_write`、`read_paid`、`all` 四种模式的含义与 [MCP Server](mcp-server.md) 相同。

## 边界

- 账号、密码、Passkey 与 API key 管理不在 CLI 内，只能由浏览器面板或服务端 CLI 完成。
- 写入密钥字段只能提交新的明文（服务端自动命名存入 Keychain），不能选用已有条目；改连接地址必须在同一次请求里重新提交密钥。密钥条目的查看、轮换与清理只在面板 **Keychain** 页。
- 查询结果可能含私密消息与 Prompt，不要直接把完整输出公开。

配套的 Agent Skill 是仓库里的 `skills/surowan-utils`，用 `npx skills add tuuject/surowan --skill surowan-utils` 安装；不想装 CLI 时也可以改用 [MCP Server](mcp-server.md) 与 `skills/surowan-mcp`。
