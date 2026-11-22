---
title: 排查启动失败和不回复
description: 按证据分流启动失败、面板与配对错误、模型与图片故障、入场闸门拦截、MCP 降级和「Bot 不回复」，并用续跑重试失败的运行。
---

# 排查启动失败和不回复

排查的顺序永远是：先固定现场，再按证据分流。绝大多数「Bot 坏了」其实是配置没应用、闸门拦下了，或者模型自己选择了沉默。

**先保住现场**：不要为了排障删数据库、媒体缓存或 `serve.lock`。留下这些信息就够开工了——发生时间、`check-config` 输出的 `config_hash`、脱敏之后的事件名与错误码。

## 启动失败

### 配置文件本身不合法

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

它只读文件，不解析密钥、不连网络。成功时输出 `{"status":"ok"}` 加上 `config_hash` 与 `warnings`；失败时输出 `{"status":"error","error":"…"}` 并以退出码 1 结束。

两类错误要分开看：

- **结构错误**以 `Invalid config:` 开头并带字段路径，例如 `Invalid config: /telegram: …`，来自 Schema：字段名拼错、类型不对、枚举值不在列表里、必填段缺失。
- **跨字段与语义错误**是一句完整的话，必须靠代码判断。常见的几条原文如下：
  - `telegram.bucket_max_seconds must be at least telegram.bucket_window_seconds`
  - `agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_max_seconds (which defaults to telegram.bucket_window_seconds)`
  - `agent.context.retained_sends_target must be smaller than retained_sends_max`
  - `telegram.decision_gate.api_key is required when telegram.decision_gate.enabled is true`
  - `Chat <id> is a private chat and cannot configure participation`（`proactive_reply`、`decision_gate` 同理）
  - `Chat <id>: provider and model must both be set when overriding agent settings`
  - `Invalid config: plaintext secrets are not accepted; …`

`warnings` 不影响启动，但值得逐条读：它包含「模型三项没配全，不会启动任何运行」「`vision` 没配全，看图与贴纸索引不可用」、`mcp.servers[].required` 已废弃、废弃字段清单，以及「`image` 段不合法、已忽略」这类降级说明。

### 文件权限

非 Windows 系统上 `serve`、`doctor` 与 `pairing` 都要求配置文件 `0600`、其父目录 `0700`，否则直接报错：

- `Config must have mode 0600: <路径>`
- `Config parent must have mode 0700: <路径>`

`chmod` 修好即可，不要改成「先关掉检查」。`data_dir` 的权限只由 `doctor` 检查。

### 密钥读不出来

配置文件里只写引用（`{ "jar": "<条目名>" }`、`env` 或 `command`），值在解析时才去读。不同段的失败方式不一样，这决定了你该看哪里：

- **Telegram Token** 读不出来**不会**阻止启动：进程照常运行，连接状态变成「配置异常」，原因是 `token_unreadable`，并在**警告**页留下 `telegram_config_error`。在**Telegram** 设置页重新保存一次 Token，或修好**密钥**（Keychain）里的条目。
- **`image` 段**的凭据解析失败会让整段按「图片生成禁用」处理，配置仍然可用。
- **入场闸门**的 `api_key` 坏掉最隐蔽：加载不报错，每次决策记一条 `secret_unresolved` 然后放行，看起来像「闸门一直在收」。开启闸门后一定要跑 `doctor`。
- **Provider 的 API key** 坏掉会在应用配置或健康检查时报 `secret_unresolved`，运行本身仍然启动，模型调用失败。

### 端口、锁与第二个进程

- 同一个 `data_dir` 只能有一个 `serve`。第二个进程会报 `Another serve process holds <data_dir>/serve.lock with PID <pid>`。本地替换实例时才用 `--takeover`。
- 单实例锁由进程持有在 `serve.lock.sqlite` 上，进程退出（含容器重建）时由内核释放；`serve.lock` 只是记录 PID 的说明文件，残留的 `serve.lock` 不会阻止下次启动，不需要手工删除。
- 面板端口被占用会直接表现为启动失败。`admin.host` 是 `127.0.0.1` 时外部访问不到，需要放反向代理或者改绑定地址。

## 面板打不开或登录不了

1. **进程在跑吗**。日志里应该有 `admin_started` 事件，带实际监听的 host 与 port。
2. **页面是空白的还是 503**。返回 `admin_bundle_missing` 说明前端产物没打包：在源码目录执行 `pnpm run admin:build` 后重启。官方镜像里产物已经打包好。
3. **登录失败**。`invalid_credentials` 是用户名或密码不对；连续失败会按调用方地址锁定，之后返回 `too_many_attempts`（HTTP 429），等一会儿再试，不要清库绕过。
4. **根本没有账号**。面板没有网页建号端点：第一个管理员只能来自服务器，`pairing create --web` 会顺手建一个无密码的 `admin`，或者停机用 `admin-account` 离线建号。操作步骤见[安装与首次登录](installation.md)。
5. **忘记密码**。有 Passkey 时可以在登录页走 Passkey；否则停机用 `admin-account` 重置。这两件事都不能由 API key 或已配对客户端完成。

## 配对与签名错误码

一次性配对、客户端签名和 API key 的错误码是稳定的字符串，直接对表：

| 错误码 | 含义与处理 |
| --- | --- |
| `pairing_code_invalid` | 配对码未知或已被取消。在服务器上重新创建一张。 |
| `pairing_code_expired` | 超过有效期（默认 300 秒）。重新创建，不要复用旧码。 |
| `pairing_code_used` | 已经领过。每张码只能用一次。 |
| `pairing_public_key_mismatch` | 预绑定公钥不匹配。用 `auth init` 打印的那把，或重建一张不预绑定的码；这张码本身没有作废。 |
| `pairing_proof_invalid` | 领取签名的格式或内容不对。确认 `client-key.pem` 没有被替换。 |
| `client_already_paired` | 这把公钥已经有一个未撤销的客户端。先在服务器上撤销旧的，或换一把密钥。 |
| `unauthenticated` | 客户端未知、已撤销，或签名不匹配；API key 无效、已撤销或权限组合非法也是这个码。 |
| `signature_clock_skew` | 本机或服务器时钟偏差超过 ±300 秒。先对时。 |
| `signature_replayed` | 同一个 nonce 被重复使用（重发请求就会出现）。重新执行命令即可，不要绕过。 |
| `missing_client_key` / `invalid_client_key` | 本机私钥文件缺失、被改动，或权限不安全。由你决定是否重新配对。 |
| `already_configured` | `auth pair` 时本地已有凭据。确实要替换才加 `--force`。 |
| `forbidden` | 凭据有效但权限不足。到**API 密钥**页改模式，或重新配对。 |

`surowan pairing` / `surowan clients` 报「数据库不存在」或「迁移 059 还没应用」时，说明这个版本还没在服务端启动过一次：先启动（或重启）一次 `serve`。

自己先自检一遍比猜快：

```bash
surowan-utils doctor --json
```

`status` 为 `ok` 说明连通与鉴权都通过，输出里 `credential`、`mode`、`permissions` 会告诉你当前用的是哪种身份、能做什么。

## 模型与 Provider

- **警告**页出现 `agent_model_missing`（critical）说明 `agent.provider`、`agent.model`、`agent.thinking_level` 没有配全，这时任何批次都不会启动运行。
- 运行状态是 `failed` 时，详情页的「完成原因」与「错误码」是分流的依据：`model_error` 查 Provider 与模型能力，`daily_token_budget` 查预算，`timeout` 查单次运行时长。
- **模型调用**标签页里能看到每次请求的 Provider、模型、思考强度、耗时与错误。先确认它请求的是你以为的那个模型。
- Provider 连通性用 **供应商**（Providers）页的健康检查验证；它会给模型发一条最小请求并把模型的回话显示出来，所以既能查错也能证明「模型确实在答」。
- 配置能加载不代表模型能用：`check-config` 只校验引用与能力声明，不连上游。

## 图片与贴纸

- **警告**页的 `vision_model_missing` 只表示 `vision.provider` / `vision.model` 没配全：聊天里的普通图片仍可能由多模态主模型直接看，但 `read_image` 与后台贴纸索引不可用。
- 工具调用里的 `vision_unconfigured` 就是没配 Vision；`image_ref_not_authorized` 表示引用的图片不在当前会话可见范围内或已过期；`vision_timeout` 与 `vision_error` 是分析与上游调用失败。
- 贴纸索引进度在 **贴纸集**（Bot sticker sets）页；索引需要 Vision 模型，且消耗 `vision.daily_budget`（与主 Agent 的每日预算分开计）。
- 图片生成整段被忽略时，`check-config` 的 `warnings` 会给出不合法字段的位置。改好或删掉该段就会重新启用。

## 入场闸门：被拦下还是密钥坏了

两种「它就是不回」在运行记录里长得不一样：

- **真的被拦下**：批次以 `skipped_budget` 结束，错误码 `decision_gate_dropped`，同时有一条 `outcome` 为 `drop` 的判断记录。这是闸门正常工作。
- **密钥坏了**：判断记录里 `error_code` 是 `secret_unresolved`，`outcome` 却是 `enter`——闸门放行了。修好密钥条目或重填密钥，然后跑 `doctor` 确认 `decision_gate` 是 `connected`。

其它判断错误码的含义：`timeout`、`network_error`、`http_error`（带 HTTP 状态）、`invalid_response`、`refusal` 都是「失败即放行」；`concurrency_limit` 表示同时在途的决策请求已达 4 个，这一批直接送入。`state` 为 `stale` 表示结论被新到的消息作废后重问，不是故障。

判断记录用客户端 CLI 或 HTTP 读，面板没有列表页：

```bash
surowan-utils decision-gate decisions --chat <会话 ID> --limit 50
```

## 外部 MCP：降级与缺描述

- **警告**页的 `mcp_server_unavailable` 列出降级中的服务器、`error_code` 与下次重连时间。`error_code` 常见的几种：`initialization_failed`（握手或工具发现失败）、`transport_error`（连接中断）、`payload_limit`（请求或结果超过配置上限）、`redirect_rejected`（HTTP 传输不接受重定向）、`reconnect_failed`（重连失败）。服务器会自动重连，不需要重启服务。
- **`mcp_description_missing`** 只出现在 `exposure: progressive` 又没写 `description` 的服务器上：网关只能拿几个工具名兜底，模型很难判断它有什么用。补一句描述即可，或者在 **MCP 服务器**（MCP servers）页用工具模型起草一份草稿。
- **`mcp_required_deprecated`** 提醒配置里还留着 `mcp.servers[].required`，它已不再生效，删掉即可。
- 启动不再等待 MCP：连不上只会让这台服务器降级，不影响 Bot 启动。工具调用失败最终落在运行详情的「工具调用」里，带 `mcp_tool_error` 或 `mcp_call_failed` 之类的错误码。

<!-- screenshot: troubleshooting/mcp-degraded | 警告页列出一台降级中的 MCP 服务器及其错误码 -->

## 群聊记忆的批次失败

**群聊记忆**（Group memory）页的整理进度能直接看出问题：状态是「连续失败 N 次」并给出重试时间。点「查看批次」有每一批的「原因」：

| 原因 | 错误码 | 含义 |
| --- | --- | --- |
| 模型输出不合格 | `group_memory_invalid_output` | 输出没通过事件 Schema 与批次内 message-id 校验；模型会被要求修正一次，仍不合格才算失败。 |
| 输出被截断 | `group_memory_length` | 一次输出没写完，撞到输出上限。 |
| 模型调用失败 | `group_memory_error` | 上游报错。 |
| 工具模型不可用 | `tool_model_unavailable`、`group_memory_unavailable` | `tool_model` 没配好、模型不可用，或批次里没有一条消息能塞进模型窗口。 |
| 已中止 | `group_memory_aborted` | 整理途中不再允许调用模型。 |
| 进程停止 / 被重启中断 | `shutdown`、`interrupted` | 服务退出或重启打断这一批。 |
| 处理超时 / 批次已作废 | `stale_claim`、`group_memory_claim_lost` | 这一批被另一轮接手，或占位已过期。 |
| 群聊记忆已关闭 / 其他错误 | `group_memory_disabled` 等 | 关闭群聊记忆后残留的批次，以及未归类的错误。 |

失败不会丢消息：批次回到待整理状态并带退避重试，下次继续。反复失败时先确认 `tool_model` 可用（它不跟随会话覆盖），再考虑把当天拆小。

## 配置漂移与废弃字段

「我改了配置但行为没变」几乎都是这两种之一：

- **文件改了没应用**。手改 `config.jsonc` 之后要到 **设置**（Settings）页点「应用配置文件」；页面上的「配置版本」一组会显示生效哈希、文件哈希，以及「与文件一致」还是「文件有改动」，「最近错误」给出上一次应用失败的原因。需要重启的字段在**会话**页顶部会显示「N 项设置正在等待重启」与「立即重启」。
- **字段属于重启生效**。哪些热应用、哪些必须重启见[配置生命周期](../configuration/lifecycle.md)；热应用字段的输入框下会显示「运行中：…」，那是正在生效的旧值。

<!-- screenshot: troubleshooting/config-drift | 设置页显示文件哈希与生效哈希不一致、文件有改动 -->

**废弃字段**不再有任何效果，`check-config` 的 `warnings` 会列出路径，**警告**页同时给出 `config_fields_deprecated`。需要清理的有：`agent.memory_ttl_warning_days`、`agent.send_empty_text_fallback_enabled`（改用 `agent.send_empty_text_strategy` 的 `random_text`）、`vision.background_sticker_concurrency`，以及 `mcp.servers[].required`。

## Bot 不回复

按顺序过一遍，前一步成立就不用看后面：

1. **消息进库了吗**。**消息**（Messages）页能按会话和时间筛；看不到这条消息说明它根本没到达 Bot（群隐私模式、Bot 被禁言、会话不在允许范围）。
2. **会在允许范围里吗**。不在 `telegram.chats` 里的会话不会被处理；刚加进配置之后确认「状态」列是「生效中」。
3. **有资格开批次吗**。活跃时段外只有 `/ask`、直接 @、回复 Bot 自己发过的消息、命中关键词能开；开启「仅 /ask 唤起」之后就只剩 `/ask`。这两项在**会话**页「编辑活跃时间」里。
4. **会话被暂停了吗**。`/pause` 之后消息照常入库但不启动运行，概览上的「管理员暂停」会列出来。
5. **Bot 在睡眠吗**。概览会显示睡眠状态与唤醒时间；睡眠期间批次以 `sleeping` 结束。需要恢复就点「立即唤醒」，但不会补跑跳过的批次。
6. **入场闸门拦下了吗**。看上一节的 `decision_gate_dropped`。
7. **有没有运行**。**运行记录**（Tool sessions）按会话筛，没有运行说明卡在 1–6；有运行就打开详情。

打开详情之后，判断「它做了什么」：

- 「概要」的「状态」是 `completed` 而「发送」为 0：模型读完选择沉默，这是正常结果。
- `failed` / `aborted` / `outcome_unknown`：看「完成原因」与「错误码」，这时可以考虑续跑。
- 有 `send` 工具调用但失败：错误码会说明是发送规则（重复、空文本、长度、引用）、权限还是 Telegram 侧拒绝。

<!-- screenshot: troubleshooting/tool-calls | 运行详情页的工具调用与 Telegram 发送结果 -->

界面上看不到结论时，用脚本在命令行读同一份审计：

```bash
node scripts/audit.ts invocation <运行 ID>
```

它把某次运行的入队、上下文、模型调用、工具调用与发送摊开成时间线，包括我们上面一直在说的那些状态与错误码。

## 续跑失败的运行

`failed`、`aborted` 或 `outcome_unknown` 的最新一次运行可以在详情页点「续跑」。它用当前配置真实地再跑一次，可能发消息、也可能花钱，所以对 API key 调用方要求 `write+paid`。

被拒绝时返回的错误码直接说明原因：

| 错误码 | 含义 |
| --- | --- |
| `resume_not_failed` | 只有失败、中止或结果未知的运行可以续跑。 |
| `resume_not_latest` | 这个会话后面还有别的运行；只能续跑最新的一次。 |
| `resume_conversation_busy` | 会话里还有排队或运行中的运行。 |
| `resume_host_unavailable` | Telegram 停用或没连上，运行也起不来。 |
| `resume_sleeping` | Bot 在睡眠，先唤醒。 |
| `resume_chat_removed` / `resume_topic_removed` / `resume_chat_paused` | 会话被移除、话题不再允许，或被暂停。 |
| `resume_agent_unconfigured` | 会话的模型配置不完整。 |
| `resume_unsupported_host` | 虚拟群聊的失败运行走房间自己的重试，不走续跑。 |

<!-- screenshot: tuning/invocation-resume | 失败运行的详情页，续跑按钮与实时刷新开关 -->

续跑不是重放：重放不产生 Telegram 副作用，也不会继续这个会话的上下文，见[Invocation 预检与重放](../developer/replay.md)。

## 还没有定位

带上这些材料去找人帮忙，基本一次就能说清：`check-config` 的完整输出（`config_hash` 有用）、事件名与错误码、时间范围、涉及的会话 ID、以及一次运行记录的 ID。需要脱敏的地方自己先遮掉，不要贴 Token、API key、`key.json` 或完整消息正文。
