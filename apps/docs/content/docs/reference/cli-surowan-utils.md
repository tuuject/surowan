---
title: surowan-utils 客户端
description: 安装 Admin API 工具客户端、保存凭据并完成首次连通检查。
---

# surowan-utils 客户端


`packages/cli` 提供 Admin API 工具客户端 `surowan-utils`（npm 包 `@tuuject/surowan-utils`），用于只读检查当前配置与 prompt、查询/导出/重放 Invocation。子命令为 `invocation list` / `get` / `prompts` / `preflight` / `media` / `replay`、`models list`、`config show` 与 `prompt get global|group`，另有 `login`（把 endpoint 与 API key 成对保存到本机）与 `doctor`（一次只读请求验证连通与鉴权）；群聊管理等其它能力尚未实现，也不包含 SDK 或 Eval 能力，`login` 也不提供服务端密钥管理（密钥的创建与撤销仍只在面板进行）。

它与服务端入口 `plasticwan`（`node src/cli.ts`）不同：本客户端直接访问 Admin API，不包含 `serve`、`check-config`、`backup`、`configure` 等服务命令；客户端自己的 `doctor` 也不执行服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针，只检查 Admin API 连通与鉴权。

从 npm 全局安装（Node.js ≥ 24，无额外运行时依赖；命令名为 `surowan-utils`）：

```bash
npm install -g @tuuject/surowan-utils           # 稳定版，dist-tag latest
npm install -g @tuuject/surowan-utils@canary    # main 分支的 canary 构建
surowan-utils --help
```

自动发布中，`latest` 来自维护者推送的稳定 tag，`canary` 随 `main` 的成功发布更新且不移动 `latest`；试用版须显式指定 `@canary`。registry 上还没有该包（安装返回 404）时，先在源码仓库安装依赖，再打包后本地安装：

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-surowan-utils-0.1.0.tgz   # 文件名以实际打包输出为准
```

不想全局安装时，也可以直接运行构建产物：`node packages/cli/dist/bin.js …`。维护者的自动化发布、首次发布 bootstrap 与 trusted publisher 配置见仓库的 [packages/cli/RELEASING.md](https://github.com/tuuject/surowan/blob/main/packages/cli/RELEASING.md)。

客户端用 API key 认证；密钥在面板的 **Manage → API keys**（`/api-keys`）页面创建、查看与撤销，明文只在创建弹窗出现一次，关闭后不可再取回，见[使用管理面板](../configure/admin-api-keys.md#api-密钥)。密钥的能力面是只读检查（配置与 prompt 视图、可用模型列表、场景所用的当前 prompt、重放预检、媒体导出）与 Invocation 读/重放；不要把真实 key 写进命令参数、聊天或 Skill 文件，也不要手动 `export` 明文 key（会进入 shell 历史）。

## 首次使用

1. 在面板创建密钥并立即保存明文。
2. 由操作员在本机运行 `surowan-utils login`，逐项输入 Admin Panel 基地址与 API key（key 隐藏输入、不回显）：

   ```bash
   surowan-utils login
   ```

   endpoint 与 key 成对保存在固定路径 `~/.config/surowan-utils/credentials.json`（所有平台一致；与 Bot 的 `config.jsonc`、`key.json` 无关，同一时间只保留最近一次 `login` 的一对凭据）。文件**未加密**，请当密码对待；POSIX 上目录 `0700`、文件 `0600`（更窄的权限同样接受）；Windows 不做 POSIX mode 检查，权限由用户目录 ACL 继承，工具不承诺 `chmod` 级别的保护。既有文件是符号链接、不是普通文件或权限不安全时，读写都拒绝且不自动修复或替换，需人工处理。`login` 不访问服务器，保存成功不代表鉴权已通过；序列化后超过 16384 字节会被拒绝，且写入失败（含拒绝）不会覆盖旧凭据。
3. 验证连通与鉴权；只有退出码 0 才继续：

   ```bash
   surowan-utils doctor --json
   ```

   `doctor` 恰好发起一次 `GET /api/invocations?limit=1`，没有 replay、没有模型/Provider 调用，也不发送 Telegram 消息；成功时 stdout 为 `{"status":"ok","endpoint":…,"credential_sources":{"endpoint":"argument|environment|file","api_key":…}}`，不输出 Invocation 正文，失败不自动重试；鉴权会在服务端更新密钥的 `last_used_at`。失败时 stderr 为 `{"error","message"}`：参数/环境变量给出的凭据缺失或不合法（`missing_endpoint`、`missing_api_key`、`invalid_api_key` 等）退出码 `2`，保存文件无效（`invalid_credentials`）或请求失败退出码 `1`。
4. 只读检查与查询 Invocation：

   ```bash
   surowan-utils config show --json
   surowan-utils prompt get global --json
   surowan-utils models list --json
   surowan-utils invocation prompts 12345 --json
   surowan-utils invocation preflight 12345 --json
   surowan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
   surowan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
   surowan-utils invocation get 12345 --json
   ```

无人值守环境用非交互方式；示例中的变量都由安全渠道注入，不含明文 key：

```bash
# endpoint 与 key 已注入环境变量；login 读取它们并保存，不回显
surowan-utils login --json

# 或让 key 只经标准输入进入：读到 EOF（不是读到第一行就停），累计不超过 4098 字节，
# 读取结束后只去掉一个尾部 LF/CRLF，其余换行/空白/控制字符非法（受 --timeout-ms 约束；不是 --api-key -）
# SECRET_KEY 由安全渠道注入；它不是 CLI 读取的环境变量，CLI 只从 stdin 收下这段内容
printf '%s' "$SECRET_KEY" | surowan-utils login --endpoint "$SUROWAN_ENDPOINT" --api-key-stdin --json
```

凭据解析顺序为命令行参数 > 环境变量 > 保存文件。参数或环境变量显式给出的空串按缺失/非法处理，不会回退到下一来源或改为提示（`missing_endpoint`/`missing_api_key`/`invalid_api_key`）。endpoint 与 key 都由参数或环境变量明确给出时完全不读取凭据文件（文件损坏、是符号链接或权限不安全也不影响）；只给其一才读文件，文件问题以 `invalid_credentials` 失败（退出码 1）。保存的 key 只属于其保存时的规范化 endpoint：当前 endpoint 与文件 endpoint 经 `parseEndpoint` 规范化后不一致就不会使用该 key（缺少显式 key 报 `missing_api_key`，退出码 2），规范化后一致则仍可使用。参数与环境变量不会被写回文件（只有 `login` 写文件）。`login --json` 输出 `{"status":"saved","endpoint":…,"credentials_file":…}`，不含 key。
