# CLI 配对（首次接入与凭据修复）

本指南用于两类情况：**首次**让本机 `surowan-utils` 访问一个 Surowan 实例（尤其是只有 SSH 可达、没有公网 HTTPS 的 VPS），以及已配对客户端的凭据失效、需要重新配对或切换权限模式。日常任务仍从入口的 `doctor --json` 与其它主题文档开始。

## 边界：可以做什么，不能做什么

- 可以运行 `auth init`、`auth pair`、`auth status`、`auth permissions`。配对码是一次性、短期（默认 300 秒）的 `pwp_` 码，不是长期凭据，可以出现在命令与结果里；仍不要主动把码写进报告正文，除首次配对需要传给本机 CLI 之外不复述。
- 仍**不能**运行 `login`、不能索要或打印管理员密码 / API key / token，也不能读取、打印、复制或枚举 `~/.config/surowan-utils/credentials.json` 与 `client-key.pem`。`auth logout` 只删除本机文件，不是授权动作，但会打断后续命令，执行前先确认当前任务确实要更换凭据。
- 选择 `--mode` 高于 `read` 需要用户明确授权：写操作要 `read_write`，计费操作要 `read_paid`，两者都要则是 `all`。不要为了“以后可能用到”直接创建 `all`。
- 服务端命令只能通过用户已授权的 SSH 访问执行；不要猜测别的 endpoint，不要把配对码或私钥发送到用户未授权的主机。

## 前提检查

1. 确认本机已安装 `surowan-utils`（`surowan-utils --help`），并能通过已授权的 SSH 在服务器上运行服务端 CLI（源码部署为 `node src/cli.ts`；Docker 部署为 `docker compose exec -u surowan <service> node /app/src/cli.ts`）。
2. 运行一次 `surowan-utils auth status --json`：
   - `{"status":"not_configured", ...}`：还没有凭据，按下方流程配对。
   - `{"status":"ok", ...}`：已有可用凭据，先回到入口运行 `doctor --json`，不要重新配对。
   - 退出码 `1` 且 `error` 为 `invalid_client_key` / `invalid_credentials`：本机文件损坏或被改动，先报告，得到确认后再 `auth logout` 并重新配对。

## 首次配对流程

```bash
# 1. 本机生成（或复用）客户端密钥；没有私钥时才会创建
surowan-utils auth init --json

# 2. 在服务器上创建一次性配对码（与运行中的 serve 共存，不要停服务）
#    Docker 部署用 docker compose exec -u surowan <service> node /app/src/cli.ts …；
#    必须带 -u surowan（exec 默认 root，会留下 root 所有的 SQLite 文件），不要用 run --rm
surowan pairing create --config <config> --name <agent-name> --mode read_write

# 3. 本机领取配对码；endpoint 用用户实际提供的地址（loopback + SSH 隧道或 HTTPS）
surowan-utils auth pair --endpoint <url> --code <pwp_…> --json

# 4. 验证
surowan-utils doctor --json
```

- `pairing create` 输出的 `admin.host`/`admin.port`/`admin.public_url` 只是连接提示；`next` 字段给出可直接执行的 `auth pair` 命令。明文 `http` 仍然只允许 loopback：没有 HTTPS 时让用户在本机建立 `ssh -N -L <port>:127.0.0.1:<port> user@host`，再用 `--endpoint http://127.0.0.1:<port>`。
- `auth pair` 已保存凭据时会以 `already_configured`（退出码 2）拒绝；只有用户明确要求替换时才加 `--force`。
- 预绑定流程（希望配对码只接受某个公钥时）：`auth init --json` 打印 `public_key` → 服务器 `pairing create --public-key <public_key> …` → 本机 `auth pair`。
- 配对码过期返回 `pairing_code_expired`、已用返回 `pairing_code_used`、被取消返回 `pairing_code_invalid`：重新在服务器创建一次即可，不要复用旧码或反复重试同一个码。

## 成功之后

```bash
surowan-utils doctor --json          # credential: "client_signature"，带 mode 与 permissions
surowan-utils auth permissions --json
```

后续所有命令自动签名（每个请求带 `Authorization: Surowan-Signature …`，绑定 instance、method、target、body 摘要、时间戳与一次性 nonce）。服务端按与 API key 相同的模式授权，账号、密码、Passkey 与 API key 管理仍不可达（403）。

## 失败与修复

| 现象 | 处理 |
| --- | --- |
| `unauthenticated` | 服务端身份未知或已被撤销。让用户确认；若已被撤销，需要重新走上面的配对流程（旧身份无法恢复） |
| `signature_replayed` | 同一请求被重发（例如重试了同一个已完成的请求）。这是安全拒绝，不要绕过；重新执行命令生成新请求 |
| `signature_clock_skew` | 本机或服务器时钟偏差超过 ±300 秒。报告并请用户校正时间，不要反复重试 |
| `missing_client_key` / `invalid_client_key` | 本机 `client-key.pem` 缺失、符号链接、权限过宽或不是 Ed25519 PKCS#8。先报告；得到确认后 `auth logout` 并重新配对 |
| `forbidden` | 模式不足。按当前任务说明需要 `read_write` / `read_paid` / `all`，由用户授权后：服务器上先 `clients revoke <旧 client id>`（同一把公钥在旧身份撤销前再配对会得到 `client_already_paired`），再 `pairing create --mode …`，本机 `auth pair --force` |
| `already_configured` | 已有凭据。不要覆盖；除非用户明确要求，否则先 `auth status` / `doctor` 检查现有凭据 |

## 撤销

服务端身份由用户在服务器上管理：

```bash
surowan clients list
surowan clients revoke <client-id>
```

撤销对下一次请求立即生效。本机 `surowan-utils auth logout` 只删除 `credentials.json` 与 `client-key.pem`，不会撤销服务端身份，也不会影响其他已配对客户端。
