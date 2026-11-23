---
title: 让你的本地 Agent 帮你调整塑料碗
description: 用一次性配对、API 密钥或 MCP Server 让本机 Coding Agent 安全地读写塑料碗，安装配套 Skill，并按「先读、再提案、确认后改、改后核对」协作。
---

# 让你的本地 Agent 帮你调整塑料碗

Claude Code、Codex 这类本地 Coding Agent 很适合干调优的脏活，比如翻几十条运行记录、对比两次运行的提示词，或把「为什么它不回复」追到某一行审计。前提是让它**看得到**塑料碗，同时**拿不到**你的长期密码。

本页讲三件事：用什么凭据让它连进来、怎么装配套的 Agent Skill、以及它动手时你应该盯住什么。

## 三条入口怎么选

| 入口 | 适合 | 凭据形态 | 能力边界 |
| --- | --- | --- | --- |
| SSH 一次性配对 | Agent 能登录你的服务器（或你能在服务器上执行命令） | 每台客户端自己的 Ed25519 私钥；服务端只存公钥 | 与 API key 相同的四种权限模式 |
| API 密钥 | Agent 只能访问面板地址，你愿意给一把长期 key | `pwk_` 开头的长期 key | 四种权限模式 |
| MCP Server | Agent 会 MCP，希望不装 CLI 就能用面板能力 | 只能 `Authorization: Bearer <API key>` | 由该 key 的模式决定 |

三条路走的是同一个权限闸门。账号、密码、Passkey 与 API key 管理对前两条永远不可用，MCP 的工具面里也不包含它们。这三种操作只能由浏览器面板或服务端 `surowan` 命令行完成。

## 方式一：SSH 一次性配对

这条路径解决一个具体麻烦：一个能登录你 VPS 的 Agent，如何在不被你粘贴管理员密码或长期 API key 的前提下管理这台 Bot。答案是短期一次性码加客户端签名身份，配对码可以出现在 Agent 的操作记录里，私钥不必进入任何上下文。

### 1. 本机生成客户端密钥

```bash
surowan-utils auth init --json
```

输出里有 `status`、`created`、`public_key`、`fingerprint` 和 `key_file`。重复执行是幂等的（`created` 为 `false`），不会替换已有密钥。私钥文件在 POSIX 上必须是 `0600`、其目录 `0700`，符号链接或权限过宽会被拒绝。

### 2. 服务器上创建配对码

```bash
# 直接在服务器上运行
surowan pairing create --config /path/to/config.jsonc --name coding-agent --mode read_write

# Docker 部署：对运行中的容器执行，不要用 run --rm
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --name coding-agent --mode read_write
```

Docker 下必须带 `-u surowan` 并直接写 `node /app/src/cli.ts`。`exec` 不经过镜像入口脚本，默认以 root 运行，root 打开数据库可能留下 root 所有的 SQLite 临时文件，导致 Bot 之后无法写库。

`--mode` 必须显式给出，含义与 API key 的四种模式相同（见下文）。`--ttl-seconds` 可以把有效期设为 60–3600 秒，默认 300 秒。`--public-key <公钥>` 把配对码预绑定到唯一能领取它的公钥。

输出包含一次性 `code`、`instance_id`、配对码信息、面板地址提示，以及一条可以直接复制的 `next` 命令。`pairing` 与 `clients` 需要和运行中的 `serve` 共存，不需要停服务，但要求数据库里已经有当前版本的配对表。如果还没在服务端启动过一次这个版本，命令会提示先启动或重启一次 `serve`。

### 3. 本机领取配对码

```bash
surowan-utils auth pair --endpoint https://panel.example.com/ --code pwp_… --json
```

`--endpoint` 是 Admin Panel 的基地址，明文 HTTP 只允许 loopback，远端必须 HTTPS。没有公网 HTTPS 时先在本地开一条 SSH 隧道，再指向本机端口：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@vps
surowan-utils auth pair --endpoint http://127.0.0.1:8787 --code pwp_… --json
```

领取成功后本地保存的是客户端凭据（`endpoint`、`client_id`、`instance_id`），私钥留在本机。已经保存了凭据时会以 `already_configured` 拒绝，确实要替换才加 `--force`。若配对码是用 `--public-key` 预绑定的，用另一把私钥领取会得到 `pairing_public_key_mismatch`，而且不会作废这张码。

### 4. 验证

```bash
surowan-utils doctor --json
```

`credential` 应为 `client_signature`，`mode` 与 `permissions` 是这次配对授予的权限，`credential_sources` 里会额外带 `client_key: file`。`doctor` 只用一次只读的身份查询和一次 Invocation 列表探测，不调用模型。

日常自查用两条更窄的命令：`surowan-utils auth status --json` 报告凭据类型、endpoint、`mode` 与 `permissions`（没配凭据时返回 `status: not_configured`，并说明本地是否还留着私钥），`surowan-utils auth permissions --json` 只打印当前身份能做什么。

### 之后每个请求都被签名

- 每个请求绑定 `instance_id`、HTTP 方法、路径与查询、body 摘要、Unix 秒时间戳和一次性 nonce。
- 时间戳偏离服务器时钟超过 ±300 秒返回 `signature_clock_skew`，nonce 复用返回 `signature_replayed`（重启后仍然拒绝）。
- 服务端只保存公钥，签名通过后走与 Bearer API key 完全相同的权限闸门。
- 私钥没有导出命令，也不能从命令行参数或环境变量传入。

### 查看与撤销

```bash
surowan clients list --config /path/to/config.jsonc
surowan clients revoke <client-id> --config /path/to/config.jsonc
surowan pairing list --config /path/to/config.jsonc
surowan pairing cancel <pairing-id> --config /path/to/config.jsonc
```

`clients list` 列出全部身份（含已撤销），`last_used_at` 在每次成功签名时更新，撤销对下一次请求立即生效。本机的 `surowan-utils auth logout` **只删除本地文件**，不会撤销服务端身份，所以换机或重装前先在服务器上撤销旧客户端。

## 方式二：API 密钥

密钥在面板的 **API 密钥**（API keys，`/api-keys`）页创建，创建时需要管理员 Session，密钥本身不能管理密钥。新建时四选一权限模式：

| 模式 | 能做什么 |
| --- | --- |
| 只读（`read`） | 全部审计读取、脱敏配置与提示词视图、模型列表、运行查询、媒体导出与重放预检。不改状态，不产生外部费用。 |
| 读 + 改（`read_write`） | 加上配置、会话、提示词、Memo、辞典、群聊记忆、提醒、虚拟群聊输入等写操作。不执行计费操作。 |
| 读 + 耗（`read_paid`） | 加上重放、Provider 健康检查、生图、辞典合并预览、虚拟群聊放行与重试等计费操作。不改配置与状态。 |
| 全部（`all`） | 以上全部。同时改变状态又消耗资源的操作（例如生图、虚拟群聊放行）需要这一档。 |

![API 密钥页：三种权限模式的密钥](__DOCS_BASE__/screenshots/admin/api-keys.zh-CN.light.png)

明文只在创建成功后显示一次，之后就再也拿不到，忘了只能用 **轮换**（Rotate）换一把新值。让 Agent 用它时：

```bash
surowan-utils login --endpoint https://panel.example.com/ --api-key-stdin
```

`--api-key` 会把密钥留在 shell 历史里，`--api-key-stdin` 从标准输入读到 EOF，不回显，更安全。登录文件在 `~/.config/surowan-utils/credentials.json`，未加密，一个文件只保存一种凭据（API key 或已配对客户端），后写入的生效。

## 方式三：MCP Server

塑料碗在 Admin Panel 的同一端口提供 MCP Server，路径 `/mcp`，传输是 Streamable HTTP。它随服务端发布，`admin.enabled` 为 `false` 时不监听，也就没有 MCP。

在 Agent 侧配一个请求头即可，`pwk_...` 就是上面那页创建的密钥：

```http
Authorization: Bearer pwk_<你的 API key>
```

- **只接受 Bearer API key**。已配对客户端的签名在这个入口不被接受。
- 工具名是 `surowan_<面板命令>`，和面板的 `/api` 端点一一对应。权限由 key 的模式决定，权限不足时工具直接返回错误文本，没有绕行。
- 调用 `surowan_key_show` 可以读回当前 key 的 `mode` 与三项权限，建议每次任务先读。
- 服务器会在 `skill://surowan-mcp/` 下发布 `surowan-mcp` Skill，支持 MCP with Skills 扩展的客户端可以直接读，不必单独安装。

完整工具面、协议版本与错误约定见 [MCP Server](../developer/mcp-server.md)。

## 安装两套 Agent Skill

仓库根目录的 `skills/` 是给外部 Coding Agent 用的 Skill 源，和 Bot 自己读的 System Skill 无关，也不随 npm 包分发：

```bash
npx skills add tuuject/surowan --skill surowan-utils
npx skills add tuuject/surowan --skill surowan-mcp
```

CLI 会问装到哪些 Agent，也可以用 `-a codex` 直接指定，Codex 等读取的通用位置是 `.agents/skills/<name>/SKILL.md`。不想用 skills CLI 时，把仓库里的整个目录（含子文档和 `agents/`）复制到目标位置，`SKILL.md` 不要在路径里多嵌套一层。装好后重开 Agent 会话确认它认得这个名字。

两者的分工：

- **`surowan-utils`** 走 CLI。它要求每次任务先跑 `surowan-utils doctor --json`，只有退出码 `0` 且 `status` 为 `ok` 才继续，之后按任务加载子文档（配对与凭据修复、Invocation 审计、重放、面板写操作各一篇，不一次全读）。
- **`surowan-mcp`** 走 MCP。它先读 key 权限，再按工具名操作，权限不够就停下来请你去面板改模式，不找绕行。

Skill 不会随 CLI 自动升级。用 skills CLI 装的运行 `npx skills update <name>`，手工复制的是本地副本，升级时要一起同步。宿主本身仍须允许命令执行和访问你的面板地址，装 Skill 不会授予任何权限。

## 推荐的协作流程

一个可靠的调优循环是五步，缺一步就容易变成「Agent 说自己改好了」：

1. **先读**。让它跑 `doctor`、`config show`、`prompt get global`、`invocation get <id>` 这些只读命令，把结论和证据一起给你。`models list` 只是当前配置的视图，不代表上游连通。
2. **提案**。让它写出「改哪个字段、从什么改成什么、影响哪些会话、是否热应用、能不能撤销」。字段级依据在[配置参考](../configuration/fields.md)里，不在 Skill 里。
3. **你确认**。只有你明确同意的那一项才动手。`--yes` 只是机械闸门，不是授权，`--dry-run` 可以先看它到底会发什么请求。
4. **应用**。写操作走和面板完全相同的接口与校验，所以面板里能做的事它能做，面板里做不到的它也做不到。
5. **核对**。改完让它读回生效值，并给出一次真实的运行记录作为证据，不要接受「保存成功」当结论。

一句可以直接用的开场：

```text
先用 surowan-utils doctor --json 验证连通，然后审计 Invocation 12345，
说明它为什么没有回复。只查询，不要重放，也不要改任何配置。
```

## 把批改导出交给 Agent

**批改**（Reviews）导出的 Markdown 就是为这种交接写的，它自带完整提示词、每条意见、事件摘录，以及末尾一段结构化的 JSON。把文件交给已装好 Skill 的 Agent 时，它应当：

1. 先做只读连通检查（`surowan-utils doctor --json`，或 MCP 的 `surowan_key_show`）并报出 key 的模式；
2. 按提示词拉取对应运行的审计记录与当前生效的提示词；
3. 逐条给出原因、证据（运行 ID 与事件）和改动方案，等你确认后再写；
4. 遇到「开发者反馈」用途时，明确不改运行中的配置，只输出缺陷报告。

消息、摘录、模型输出与工具参数在导出文件里都被声明为**不可信数据**，只有你写的批改意见代表真实意图。重放会真实调用模型并计费，先跑免费预检，并且只有在你明确授权目标、次数和覆盖项之后才执行。

![批改页的导出用途选择与导出确认弹窗](__DOCS_BASE__/screenshots/tuning/review-export.zh-CN.light.png)

## 不该让它做的事

- 不要把面板密码、Passkey、管理员 Session 或 `key.json` 放进对话、Skill 或环境变量，需要凭据就让它在允许的三种方式里挑一种。
- 不要让它调用交互式 `configure` 去创建第一份配置，它需要 TTY，而且只编辑已有的可加载配置。
- 不要让 Agent 为了让某个命令跑通去删数据库、媒体缓存或 `serve.lock`。
- 不要用 `--if-match` 强行覆盖别人的并发修改，拿到 `config_conflict` 或 `prompt_conflict` 就重新读取、重新确认。
- 不要把它当成权限提升工具，账号、密码、Passkey 和 API key 管理永远只能由你自己在浏览器或服务器上完成。

Agent 连不上、签名报错、权限不足时怎么办，见[排查启动失败和不回复](troubleshooting.md)。每一条客户端命令的完整参数在[客户端 CLI（surowan-utils）](../developer/client-cli.md)，HTTP 侧的鉴权约定在 [HTTP 公共约定](../developer/http/index.md)。
