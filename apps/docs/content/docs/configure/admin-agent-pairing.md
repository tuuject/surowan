---
title: 让 Agent 通过 SSH 配对
description: 在服务器上创建一次性配对码，在本机用 surowan-utils auth pair 领取；之后每个请求由客户端私钥签名，长期凭据不进入 Agent 上下文。
---

# 让 Agent 通过 SSH 配对

这条路径解决一个具体的麻烦：一个能登录你 VPS 的编码 Agent，如何在不被你粘贴管理员密码或长期 API key 的前提下，管理这台 Bot。

答案是一次性配对码加客户端签名身份：

1. 在服务器上用 `surowan pairing create` 打印一个短期、只能使用一次的 `pwp_` 码（默认 300 秒有效）。
2. 在本机用 `surowan-utils auth pair` 领取它。客户端自己生成一对 Ed25519 密钥，私钥留在本机 `~/.config/surowan-utils/client-key.pem`。
3. 之后每个 `surowan-utils` 命令都自动签名；服务端只保存公钥，并按与 API key 相同的模式授权。

配对码是短期的，不是长期凭据，因此可以出现在 Agent 的操作记录里；私钥、管理员密码与 API key 都不必进入上下文。服务端只保存配对码的摘要，`pairing list` 也不会回显它。

## 前提

- 已安装 `surowan-utils`（见 [CLI 参考](../reference/cli-surowan-utils.md)）。
- 能通过 SSH 在服务器上运行服务端 `surowan`（`node src/cli.ts`；Docker 部署见下文的 `docker compose exec` 写法）。配对命令与运行中的 `serve` 共存，**不需要停服务**。
- 服务端已经以当前版本启动过一次，迁移 `058` 已应用；否则命令会提示先启动（或重启）一次 `serve`。

## 步骤

### 1. 本机生成客户端密钥

```bash
surowan-utils auth init --json
```

输出 `{ "status": "ok", "created": true, "public_key": "…", "fingerprint": "SHA256:…", "key_file": "…/client-key.pem" }`。重复执行是幂等的（`created: false`），不会替换已有密钥。密钥文件在 POSIX 上必须是 `0600`、目录 `0700`，符号链接或权限过宽会被拒绝。

### 2. 在服务器上创建配对码

```bash
# 直接运行
surowan pairing create --config /path/to/config.jsonc --name coding-agent --mode read_write

# Docker 部署：对运行中的容器执行，不要用 run --rm
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --name coding-agent --mode read_write
```

Docker 下必须带 `-u surowan` 并直接写 `node /app/src/cli.ts`：`exec` 不经过镜像入口脚本，默认以 root 运行，root 打开数据库可能留下 root 所有的 SQLite 临时文件，导致 Bot 之后无法写库。

输出包含一次性 `code`、`instance_id`、`pairing`（名称、模式、权限、预绑定公钥指纹、创建与过期时间）、`admin`（`host`/`port`/`public_url` 提示）以及可直接执行的 `next` 命令。

`--mode` 必须显式给出：

| 模式 | 用途 |
| --- | --- |
| `read` | 只读审计、配置与 Prompt 脱敏视图、Invocation 查询与重放预检 |
| `read_write` | 加上配置、Chat、Prompt、Memo Pad、辞典、群聊记忆等写操作 |
| `read_paid` | 加上重放、Provider 健康检查、生图等计费操作 |
| `all` | 以上全部 |

`--ttl-seconds` 可把有效期设为 60–3600 秒。`--public-key <公钥>` 会把配对码预绑定到唯一能领取它的公钥（见下文「预绑定公钥」）。

### 3. 本机领取配对码

```bash
surowan-utils auth pair --endpoint https://panel.example.com/ --code pwp_… --json
```

`--endpoint` 是 Admin Panel 基地址。没有公网 HTTPS 时，先在本地建一条 SSH 隧道，再指向 loopback：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@vps
surowan-utils auth pair --endpoint http://127.0.0.1:8787 --code pwp_… --json
```

明文 HTTP 只允许 loopback，远端必须 HTTPS。`auth pair` 写入客户端形式的凭据 `{endpoint, client_id, instance_id}`；已有凭据时会以 `already_configured`（退出码 2）拒绝，只有确实要替换时才加 `--force`。

### 4. 验证

```bash
surowan-utils doctor --json
```

`credential` 为 `client_signature`，`mode` 与 `permissions` 是这次配对授予的权限，`credential_sources` 额外带 `client_key: file`。`doctor` 只用 `GET /api/key` 与一次只读 Invocation 列表探测，不调用模型。

## 预绑定公钥

如果希望配对码只接受某个特定公钥（例如密钥已经先建好、或想避免配对码被转发到别处）：

```bash
surowan-utils auth init --json                 # 本机：拿到 public_key
surowan pairing create --config … --name … --mode read --public-key <public_key>
surowan-utils auth pair --endpoint … --code … --json
```

用另一把私钥领取会得到 `pairing_public_key_mismatch`，而且**不会**作废这张配对码——正确的那把仍可领取。

## 安全边界

- 私钥只存在于本机 `client-key.pem`，以 PKCS#8 PEM 保存，与凭据文件相同的文件规则（普通文件、非符号链接、`0600`、目录 `0700`、原子写入）。它不会被打印、不能从命令行参数或环境变量传入，也没有导出命令。
- 每个请求签名绑定 `instance_id`、HTTP 方法、路径与 query、body 摘要、Unix 秒时间戳和一次性 nonce。时间戳超出 ±300 秒返回 `signature_clock_skew`，nonce 复用返回 `signature_replayed`（重启后仍然拒绝）。服务端在**读完 body 之后**用当时的时间再次检查窗口并重新读取客户端状态，所以慢速上传不会让请求“用旧时钟”通过，读取过程中被撤销的客户端也不会被派发；nonce 的保留时间按请求时间戳推导（`ts + 301` 秒），覆盖窗口最后不足一秒的边界。
- 服务端验证通过后走与 Bearer API key 完全相同的权限闸门；账号、密码、Passkey 与 API key 管理对配对客户端永远 403。
- 签名验证使用 WebCrypto（Ed25519 与 SHA-256），不依赖 Node 专有 API。
- 已有 API key 与 `surowan-utils login` 的行为不变；同一个凭据文件一次只保存一种凭据，后写入者生效。
- MCP Server（`/mcp`）仍只接受 Bearer API key。

## 查看与撤销

```bash
surowan clients list --config /path/to/config.jsonc
surowan clients revoke <client-id> --config /path/to/config.jsonc
surowan pairing list --config /path/to/config.jsonc     # 仍可用、未使用、未过期的配对码
surowan pairing cancel <pairing-id> --config /path/to/config.jsonc
```

`clients list` 返回全部身份（含已撤销），其中 `last_used_at` 在每次成功签名时更新。撤销对下一次请求立即生效，重复撤销会报错。`pairing list` 不会回显配对码。

本机的 `surowan-utils auth logout` 只删除 `credentials.json` 与 `client-key.pem`，**不会**撤销服务端身份；换机或重装前先在服务器上撤销旧客户端。

## 故障排查

| 错误码 | 含义与处理 |
| --- | --- |
| `pairing_code_invalid` | 配对码未知或已被取消；在服务器重新创建 |
| `pairing_code_expired` | 超过有效期（默认 300 秒）；重新创建，不要复用 |
| `pairing_code_used` | 已领取过；每张码只能使用一次 |
| `pairing_public_key_mismatch` | 预绑定公钥不匹配；用 `auth init` 打印的那把，或重新创建未预绑定的码 |
| `pairing_proof_invalid` | 领取签名的格式或内容不对；确认 `client-key.pem` 未被替换 |
| `client_already_paired` | 该公钥已有一个未撤销的客户端；先撤销旧的或换一把密钥 |
| `unauthenticated` | 客户端未知、已撤销或签名不匹配 |
| `signature_clock_skew` | 本机或服务器时钟偏差超过 ±300 秒 |
| `signature_replayed` | 同一请求被重发；重新执行命令即可，不要绕过 |
| `missing_client_key` / `invalid_client_key` | 本机密钥文件缺失、被改动或权限不安全；报告后由操作员决定是否重新配对 |

其它常见问题见 [排查问题](../operations/troubleshooting.md)。
