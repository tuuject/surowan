---
title: 服务端 CLI
description: serve、check-config、doctor、backup、configure、admin-account、pairing 与 clients 八个命令的选项、停机边界与 Docker 写法。
---

# 服务端 CLI

服务端入口是仓库里的 `node src/cli.ts`（`package.json` 的 bin 名 `surowan`）。每个命令都要求显式给出 `--config <path>`，成功时向 stdout 写一行 JSON，失败时向 stderr 写 `{"status":"error","error":"…"}` 并以退出码 `1` 结束。没有 `--json` 开关，因为输出本来就是给脚本消费的 JSON。

错误信息会经 `SecretStore.redact` 脱敏，但不要把完整日志当安全材料公开。

## 命令一览

| 命令 | 作用 | 与运行中的 `serve` |
| --- | --- | --- |
| `serve` | 启动 Bot 与 Admin Panel | 自身 |
| `check-config` | 只做 JSONC、语义与引用校验 | 可共存 |
| `doctor` | 探测真实依赖与外部连接 | 可共存，但会消耗模型与网络 |
| `backup` | 保留清理 + SQLite 备份 + 图片快照 + 轮换 | 可共存 |
| `configure` | 交互式改写配置文件 | 可共存，但改的是磁盘文件 |
| `admin-account` | 离线创建或重置管理员账号 | **必须先停服务** |
| `pairing …` | 一次性配对码 | **必须与 `serve` 共存** |
| `clients …` | 查看与撤销已配对客户端 | **必须与 `serve` 共存** |

`pairing` 与 `clients` 不取数据目录的 `ServeLock`、不跑迁移，所以它们能在服务运行期间从 SSH 直接操作，反过来它们要求数据库已由本版本的 `serve` 迁移过（迁移 `059`），否则会提示先启动一次 `serve`。`admin-account` 正相反，它要持有数据目录锁，服务在跑时直接拒绝，也不会抢占锁。

## serve

```bash
node src/cli.ts serve --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc --takeover
```

启动成功后会打出 `admin_started`（启用面板时，带实际监听的 host 与 port）与 `serve_started`，后者带 `mode`（Telegram 连接状态，未配置 token 时为 `disabled`）、`bot_id` 与 `config_hash`。

- `--takeover` 只用于替换当前持有同一数据目录锁的本地实例，它请求旧实例优雅退出再取锁，不是生产 supervisor 的替代品。
- 配置里 `admin.enabled` 与 Telegram token 不能同时缺失或关闭，否则进程直接报错退出，`admin.enabled` 省略时为 `true`。
- 配置了 Telegram token 时同时连 Telegram，没有 token 时只提供面板与虚拟群聊。

## check-config

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

输出 `{"status":"ok","config_hash":…,"warnings":[…],"image_enabled":…}`。它只读配置，不解析 SecretRef、不连数据库、不访问网络，所以只能证明「文件能被接受」，不能证明凭据、Provider、Telegram 或 MCP 可用。`warnings` 会包含废弃字段与降级项（见[配置生命周期](../configuration/lifecycle.md)）。

## doctor

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
node src/cli.ts doctor --config /path/to/config.jsonc --output-agent-prompt
```

`doctor` 真的去连那些依赖，而不是做静态检查。它会：

- 解析全部 SecretRef（这一步同时会把旧格式的 `key.json` 迁移成 Keychain），并检查配置文件两端的权限：非 Windows 上配置文件必须是 `0600`、其父目录必须是 `0700`，`data_dir` 不得给 group/other 任何权限。
- 建目录后检查文件系统剩余空间（少于 100 MiB 直接失败）、SQLite 的 FTS5 trigram、Sharp 的图片编解码、`ffmpeg`/`ffprobe` 与 Lottie 渲染链路。
- 检查镜像内置的用户手册是否已打包（缺了说明没跑 `pnpm run manual:prepare`）。
- 给每个 Provider 发一次最小的连通性请求，再对每个已配置的 Agent 模型发一次**必须产生严格 Tool Call** 的请求，有 Vision 模型时还会发一张 1×1 图片。这些请求会真实消耗 Token 与费用，并且会以 `role = 'doctor'` 写进 `model_calls` 审计。
- 配置了 Telegram token 时调用 `getMe`，没有 token 时跳过 Telegram 探针，成功输出的 `telegram_status` 为 `disabled`、`telegram_bot_id` 为 `null`。token 引用读不出来是配置错误，会让 `doctor` 失败，而不是静默当作「没有 Telegram」。
- 入场闸门（Decisions）在全局或任一 Chat 启用时，解析它的 `api_key` 并发一次最小请求，失败即 `doctor` 失败。这条探针很实用，因为密钥引用断了时运行期会一直放行并安静下来，看起来和「闸门总是在拦截」一模一样。
- 启动所有已配置的 MCP Server 并等待连接结果。**连不上只进警告**（`mcp_unavailable` 列出 `alias:错误码`），不会让 `doctor` 失败，因为运行期它只会降级。

成功输出大致长这样：

```json
{
  "status": "ok",
  "runtime": "v24.0.0",
  "fts5_trigram": true,
  "sharp": true,
  "ffmpeg": true,
  "ffprobe": true,
  "lottie": true,
  "manual_documents": 42,
  "providers": 2,
  "vision": "openrouter/some-vision-model",
  "mcp_servers": 3,
  "mcp_unavailable": ["notes:connect_timeout"],
  "telegram_status": "connected",
  "telegram_bot_id": "123456789",
  "decision_gate": { "status": "disabled", "model": null, "base_url": null },
  "config_hash": "…"
}
```

`--output-agent-prompt` 额外把渲染好的 Agent system prompt（含模板变量替换）放进 `agent_prompt`，用来核对人格与变量，而不是拿去给模型用。

## backup

```bash
node src/cli.ts backup --config /path/to/config.jsonc
```

输出 `{"status":"ok","backup":"<路径>"}`。顺序是：先按 `retention` 清理过期数据、扫掉过期图片素材与 Memo blob，再用 `VACUUM INTO` 生成一致性快照，然后把 `<data_dir>/images` 复制成同名的 `<备份名>.images/` 目录，最后按 `retention.backup_copies` 轮换旧备份。

图片目录快照是尽力而为，目录不存在就跳过，复制失败只记录日志，SQLite 备份本身仍然有效。两处没有跨存储原子性，恢复后仍要在隔离环境验证（见[升级、备份与恢复](../guides/maintenance.md)）。

## configure

```bash
node src/cli.ts configure --config /path/to/config.jsonc
```

交互式改写**已存在且能加载**的配置：Provider 向导与 Agent thinking level。它要求 stdin 是 TTY，没有 TTY 直接报错退出，不是无人值守的初始化器，也不适合让部署 Agent 自动调用。保存时以原文件哈希作为 revision 写入，写完立即重新加载校验，任何失败都不会留下半成品。

## admin-account

```bash
node src/cli.ts admin-account --config /path/to/config.jsonc --username admin
printf '%s' "$NEW_PASSWORD" | node src/cli.ts admin-account --config /path/to/config.jsonc --username admin --password-stdin
node src/cli.ts admin-account --config /path/to/config.jsonc --username admin --password-stdin --revoke-passkeys
```

离线账号管理，完全不碰 Telegram、不启动面板、不建 Session：

- 没有管理员时创建，已有时把唯一管理员的用户名与密码改成给定值。
- 每次都撤销该账号的全部登录 Session，Passkey 默认保留，加 `--revoke-passkeys` 才删除。
- 不修改 API key，也不触碰配对客户端。
- 必须能取到数据目录锁，所以服务必须停着，它不会抢占锁。
- 密码只从隐藏的 TTY 提示或 stdin 读取，绝不出现在 argv（shell 历史）里。`--password-stdin` 最多 800 字节、10 秒不结束就放弃，读到 EOF 后只去掉一个尾部 LF/CRLF。
- 输出 `{"status":"ok","username":…,"created":…}`。

首次登录的正规路径是 `pairing create --web`，`admin-account` 仅作停机恢复手段（见[管理面板、密钥与访问安全](../guides/admin.md)）。

## pairing 与 clients

```bash
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read_write
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read --ttl-seconds 600
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read --public-key <base64url>
node src/cli.ts pairing create --config /path/to/config.jsonc --web
node src/cli.ts pairing list --config /path/to/config.jsonc
node src/cli.ts pairing cancel 12 --config /path/to/config.jsonc
node src/cli.ts clients list --config /path/to/config.jsonc
node src/cli.ts clients revoke 7 --config /path/to/config.jsonc
```

`pairing create`（客户端形式）：

- `--name` 必填，1–80 字符。
- `--mode` 必填，取 `read` / `read_write` / `read_paid` / `all`，缺省不给最宽权限。
- `--ttl-seconds` 取 60–3600，默认 300。
- `--public-key` 可选，把配对码预绑定到唯一能领取它的公钥（32 字节 base64url，43 字符、无填充），别的密钥来领会得到 `pairing_public_key_mismatch`，且不会作废这张码。

`pairing create --web` 生成面板登录码，不接受 `--mode` 与 `--public-key`（面板 Session 就是整个面板），`--name` 可省略（默认 `Admin Panel sign-in`），实例上没有管理员时顺手创建一个无密码的 `admin`。

两者的输出都是同一份结构：`status`、`code`（一次性 `pwp_` 明文，唯一一次出现）、`instance_id`、`pairing`（`purpose`、`name`、`mode`、`permissions`、预绑定公钥指纹、创建与过期时间）、`admin`（`host`、`port`、`public_url`）以及可直接执行的 `next`，`--web` 还多一个 `account`（`id`、`username`、`created`）。

`pairing list` 只列仍可用、未使用、未过期的码，不回显明文。`pairing cancel <id>` 与 `clients revoke <id>` 的 id 是十进制 `pairing` / `client` 行 ID。

`clients list` 返回全部身份（含已撤销），`last_used_at` 在每次成功签名时更新。撤销对下一次请求立即生效，重复撤销报错。完整签名协议见 [HTTP 公共约定](http/index.md)，操作流程见[与 Agent 配合使用](../guides/agent-assisted.md)。

## Docker 写法

镜像的 `ENTRYPOINT` 是 `/usr/local/bin/docker-entrypoint.sh`，它把参数交给 `node /app/src/cli.ts` 并以 `surowan` 用户运行，`CMD` 默认是 `serve --config /config/config.jsonc`。

一次性命令用 `run --rm`，它会替换 `CMD`，因此可直接写子命令：

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

不要用 `docker compose run` 再起一个 `serve`，那会绕开锁成为第二个实例。

`pairing` 与 `clients` 必须对着**运行中的容器**执行，用 `exec`：

```bash
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
docker compose exec -u surowan plasticwan node /app/src/cli.ts clients list --config /config/config.jsonc
```

`exec` 不经过 `ENTRYPOINT`，默认以 root 运行。root 打开 SQLite 会留下 root 所有的临时文件，之后 Bot 就写不进去了，所以 `-u surowan` 与直接写 `node /app/src/cli.ts` 都不是可选项。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（`doctor` 里 MCP 不可达仍算成功） |
| `1` | 任何失败：配置错误、权限不符、探针失败、备份失败、命令参数不合法 |

没有单独的退出码区分失败类型，脚本要判断细节只能读 stderr 里的 `error` 字符串。CLI 不做自动重试。
