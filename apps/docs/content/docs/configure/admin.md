---
title: 使用管理面板
description: 安全访问本地 Admin Panel，查看审计、管理模型与应用配置。
---

# 使用管理面板

Admin Panel 与 `serve` 同进程启动，用于本地审计和受控管理；它不是文档站，也不应直接暴露在公网。

## 启用与安全访问

配置：

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8787,
    "session_ttl_hours": 24,
    "public_url": "https://panel.example.com"
  }
}
```

`admin` 段必填，`enabled` 可省略并默认为 `true`；`admin.*` 改动需要重启。Docker 中要从宿主机访问，容器应绑定 `0.0.0.0`，但端口发布必须限制为 `127.0.0.1:8787:8787`，再由你管理的 TLS 反向代理进行认证和访问控制。首次访问时创建管理员账号；密码长度为 12–200 字符，浏览器 Session 采用 HttpOnly 且 SameSite=Strict Cookie。

`admin.public_url` 可选，**显式配置后才会启用 Passkey 登录**（登录页出现「使用 Passkey 登录」，Settings 页出现 Passkeys 卡片）。它必须是规范 HTTPS origin：不带用户名/密码、路径、查询参数或片段，可以带一个尾部 `/`；本地开发可以用 `http://localhost`；IP 地址（包括 `127.0.0.1` 和 IPv6）不能作为 WebAuthn RP，因此不接受 IP 形式的 `public_url`，即使使用 HTTPS 也不行。启用后请始终从配置的来源访问：包括首次设置、密码登录在内的全部写操作都会校验该来源，直接访问另一个回环地址或端口会返回 `bad_origin`。Passkey 的域名绑定详见下文。

## 常用任务

- **Overview / Invocations / Messages / Contexts**：查看收到消息、运行窗口、Tool 调用和连续对话上下文；审计读取不修改数据。
- **Models**：维护 Provider、已启用模型和全局 Agent/Vision 选择。保存后查看是否成功应用。
- **Chats**：管理 Chat/Topic allowlist 与每群模型覆盖。新增 Chat 立即生效；删除 Chat 与 Topic 范围需重启；已有 Chat 的模型覆盖可热应用。每行 Chat 的「打开相关页面」菜单可直接进入该群的 Prompt、辞典、记忆、消息、Invocation 与 Alarm 视图；这些页面用 URL 的 `chat` 查询参数记住群范围（如 `/messages?chat=123456789`），可收藏或分享，页面内改选 Chat 时该参数会同步更新。
- **Chats · 活跃时间**：每行 Chat 的时钟按钮编辑该群的活跃时段，支持多个时间段并按星期生效，保存后立即应用。三种模式：不限制（移除本群时段，已配置全局时段时按全局执行）、无固定时段（仅 @、回复或触发关键词可唤醒）、自定义时段。图表按该群时区显示一周各天的时段条，并标记当前时间位置。
- **Chats · 主动回复**：每行 Chat 的星形按钮编辑普通群消息的主动参与概率；可跟随全局、关闭或自定义首次机会 / 每次增加 / 最多尝试次数。直接 @、回复 Bot 与触发关键词不受影响；保存后热应用，见[控制主动插话频率](../guides/proactive-replies.md)。
- **Prompts**：编辑全局人格与每群附加指令，查看版本历史、比较差异并恢复旧版本；保存后由下一次 Invocation 生效，见 [编辑 Prompt 与版本历史](admin-prompts.md)。
- **Memories**：查看、编辑或删除短期记忆；长 TTL 记忆应由人工审核，不要把它当永久知识库。
- **Dictionary**：维护全局与群组术语、别名和解释，查看冲突，审阅 AI 融合建议，批量导入导出并设置自动注入模式，见[辞典指南](../guides/dictionary.md)。
- **图片生成 / 生图记录 / 图片资产**：图片生成工作台（提交、解析预览、实时查看输出）、全部生成的审计与重试、提示词素材与参考图库管理，见[图片生成](../guides/images.md)。
- **图片设置**：图片功能的启用开关、生图凭据与模型配置。保存后立即应用，不需要重启；禁用会删除整个 `image` 段并清理不再引用的 key jar 条目。
- **Settings**：对手改配置使用 **Apply config file**，并查看 Saved 与 Running 状态及 `restart_required`。
- **Panel preferences**（Account 组）：只对当前浏览器生效的显示选项：主题、界面语言（右上角按钮也能切换），以及是否在设置项下显示 `config.jsonc` 键名（默认关闭）。选项保存在浏览器本地，不写入配置文件，其他浏览器与管理员互不影响。
- **Harness tuning**：调整 Agent 的运行上限与发送行为（预算、并发、发送规则、限流、Context 保留与记忆审核）以及全局主动回复默认值，保存后由下一次 Invocation 生效，见 [Harness tuning](admin-harness-tuning.md)。
- **Developer**：按需记录模型调用的调试报文，或在确认后清除已有报文，见 [Developer 调试开关](admin-developer.md)。
- **API keys**（Manage 组）：创建、查看与撤销供 CLI 与评估工具使用的密钥，明文只在创建弹窗中出现一次，见 [API 密钥](admin-api-keys.md)。
- **Invocation 重放**：仍只有携带 API 密钥的 CLI/API 入口，没有页面入口；只读的配置/prompt 检查、可用模型列表、场景 prompt、Invocation 搜索、重放预检与媒体导出同样在 CLI/API 层提供，见 [Invocation 重放](admin-invocation-replay.md)。

## 查看和复制 Telegram ID

在 **Messages** 的发送者姓名旁，可查看并复制 `Telegram user ID`；打开消息详情后，每条 Revision 也有相同入口。匿名或频道身份显示的是 `Telegram chat ID`，不能作为用户 ID 填入忽略名单。消息本身的 `Telegram message ID` 是另一项字段。

在 Invocation 详情的 **Overview** 消息卡和 **Frozen context** 的 Sender 列，复制 `Telegram sender ID` 可取得当时冻结的发送者 ID。旧记录缺少 ID 时显示 `—`，不会猜测或填入当前资料。

复制按钮只把数字 ID 放入剪贴板。浏览器拒绝剪贴板访问时，可以选中 ID 手动复制；复制不会修改 Bot 配置。用户 ID 可用于维护 `telegram.admins` 或 `ignored_user_ids`，成员自助忽略与恢复见 [Telegram 接入](telegram.md#自助忽略与恢复)。

## 界面语言

界面支持英文与简体中文。顶栏右侧的语言切换按钮在两种语言间切换，也可以在 **Panel preferences** 页直接选择，立即生效并写入浏览器 `localStorage`（`admin-language`）；未手动选择时跟随浏览器语言（`zh` 开头解析为中文，否则英文）。技术名词（Invocation、Context、Prompt、Token 等）在中文界面中保留英文原文；后端返回的错误消息始终按服务端原文显示（错误码 + 消息）。

## Passkey 登录与恢复

配置 `admin.public_url` 并重启后，Passkey 可用：登录页出现「使用 Passkey 登录」按钮，Settings 页出现 Passkeys 卡片。Passkey 绑定的是 `public_url` 的域名（WebAuthn RP = 主机名），只在访问这个来源时有效。注册与使用需要支持 WebAuthn 的浏览器，并且页面处于安全上下文（HTTPS 域名，或 `localhost` 的 HTTP）。安全上下文只是前提，不能让 IP 地址成为有效的 WebAuthn RP。

### 添加与使用

1. 打开 **Settings**，在 Passkeys 卡片点 **添加 Passkey**。
2. 输入名称（1–80 字符），用设备的屏幕锁、指纹或其他验证方式确认。
3. 之后在登录页点 **使用 Passkey 登录**，由设备选择并确认凭据即可——使用的是可发现（discoverable）凭据，无需再输入用户名。

可以注册多个 Passkey（例如办公电脑与手机各一个）。凭据绑定主机名：更换域名后旧凭据仍在列表中，但会标为无法在此登录，也不能用于满足删除密码前的保护条件；只改变同一主机名的端口并同步配置，凭据不必重建，但必须从新的精确 origin 访问。删除 `admin.public_url` 会关闭 Passkey 功能，不会删除凭据。

### 删除与仅 Passkey 模式

- **删除单个 Passkey**：行内点 **删除**，需要确认；立即失效且不可恢复，之后可以随时重新注册。
- **删除最后一个可用 Passkey 前必须先设置密码**：账号没有密码时，最后一个 Passkey 的删除按钮会被禁用，界面会提示先在上方「管理员凭据」卡片设置密码，避免把自己锁在门外。
- **删除密码**（转为仅 Passkey 登录）：前提是当前网站已注册至少一个 Passkey。删除后撤销全部旧会话，并为当前浏览器签发新会话（仍受会话过期时间限制）；下次登录只能通过 Passkey。想恢复密码，在「管理员凭据」卡片重新设置即可。

### 恢复（忘记密码或遗失 Passkey）

Passkey 遗失，或因更换域名、关闭 Passkey 功能而无法登录时，使用**服务端内置 CLI** 的 `admin-account` 本地建号或重置——不是 `surowan-utils`（它只通过 Admin API 做只读检查与 Invocation 重放，不能恢复凭据）：

1. **先停止 Bot**。命令通过 `ServeLock` 拒绝在运行中的实例上执行，不会强抢；同一 `data_dir` 的 Bot 停止后才能运行。
2. 交互式执行（终端会隐藏输入新密码并要求重复确认）：

   ```bash
   node src/cli.ts admin-account --config /path/to/config.jsonc --username <name>
   ```

3. 非交互环境用 `--password-stdin`，把密码从安全来源（密码管理器或受限权限文件）经管道传入：**不要把密码写在命令行参数里**，它会留在 shell 历史与进程列表中。

   ```powershell
   # 示例：从受限权限文件读取；实际请使用你的密码管理器输出
   Get-Content .\admin-password.txt | node src/cli.ts admin-account --config .\config.jsonc --username <name> --password-stdin
   ```

还没有管理员账号时，命令会创建该账号（不创建登录 Session）；已有唯一管理员时，把用户名和密码改成新值；表里出现多个管理员时会直接报错退出。每次执行都会注销该账号的全部登录 Session。Passkey 默认保留，需要一并撤销全部 Passkey 时加 `--revoke-passkeys`。API 密钥不受影响，首次设置流程不会重新打开。恢复或设置好密码后，再删除或更换 `public_url`/域名——改动之前请先确认至少保留一个可用登录方式。

## 验证与风险

启动日志需要有 `admin_started`。设置页面显示“已保存”不一定等于运行中已使用：若有待重启字段，确认外部监督器已重启服务后再检查配置哈希。不要共享面板密码、Cookie 或从浏览器导出的请求。

面板打不开时，请看 [排查问题](../operations/troubleshooting.md)。

## 相关页面

- [Harness tuning](admin-harness-tuning.md)
- [Developer 调试开关](admin-developer.md)
- [编辑 Prompt 与版本历史](admin-prompts.md)
- [API 密钥](admin-api-keys.md)
- [Invocation 重放](admin-invocation-replay.md)
