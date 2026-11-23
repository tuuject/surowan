---
title: AI 帮我部署
description: 刚拿到一台带 root 账号和密码的 VPS，用一段提示词让本机 Coding Agent 通过 SSH 完成 Docker、HTTPS 反向代理与首次登录码的一条龙部署。
---

# AI 帮我部署

刚从 VPS 服务商买了一台新 Linux 服务器，手里只有公网 IP、`root` 账号和初始密码，不想一条条手敲 Docker 和反向代理命令时，可以把部署交给本机的 Coding Agent（Claude Code、Codex、OpenCode、Cursor 等），由它通过 SSH 一条龙装好，最后把**首次登录的一次性码**交给你。

**需要准备**：一台新的 Linux VPS（推荐 Debian 或 Ubuntu，带 `root` 登录信息）、本机带终端执行能力的 Coding Agent，以及一个可选的域名（已把 A/AAAA 记录指向这台 VPS，用于启用 HTTPS 与通行密钥）。模型 API Key 和 Telegram Token **不需要**提前交给 Agent，等你登录面板后再自己填。

**完成标准**：容器正常运行、日志里出现 `admin_started`、面板可通过 HTTPS（或本机 SSH 隧道）打开，并且你拿到了 `pwp_` 开头的一次性登录码。

## 1. 一条龙部署提示词

把下面这段话直接发给你的本地 Coding Agent，按实际情况替换括号里的内容（没有域名就把域名那一行删掉）：

```text
请通过 SSH 帮我在这台新 VPS 上一条龙部署「塑料碗（Surowan）」：

- 服务器 IP：<你的 VPS IP>（SSH 端口默认 22，用户 root）
- 面板域名：<panel.example.com>（如暂无域名，改为「暂不配域名，仅用回环端口」）
- 反向代理偏好：Caddy（自动 HTTPS；也可换为 Nginx 或 Apache httpd）

请按以下顺序执行，并在关键节点简短汇报结果：
1. 先建立 SSH 密钥登录（检查我本机 ~/.ssh 公钥并协助写入服务器 /root/.ssh/authorized_keys），不要把 root 密码写进任何脚本、命令历史或配置文件。
2. 检查系统并安装 Docker Engine 与 Docker Compose 插件；配置防火墙时仅放行 SSH 和 80/443（有域名时），不要把 8787 暴露到公网。
3. 创建 /srv/surowan/config 与 /srv/surowan/data，下载官方的 docker-compose.yml 与最小配置 config.minimal.example.jsonc（保存为 /srv/surowan/config/config.jsonc）。
4. 取消 docker-compose.yml 里 "127.0.0.1:8787:8787" 的注释；如果我提供了域名，把 config/config.jsonc 里的 admin.public_url 设为对应的 https:// 域名，并配置 HTTPS 反向代理（确保放宽请求体上限至 35MB，并对 /api/live/ 关闭代理缓冲且拉长超时）。
5. 启动服务（docker compose up -d），查看日志确认出现 admin_started 且没有启动错误。
6. 用非 root 容器用户生成首次 Web 登录一次性码：
   docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
7. 把面板访问地址（无域名时附带本地 ssh -N -L 8787:127.0.0.1:8787 隧道命令）、一次性码和过期时间告诉我，然后停手。

安全边界：不要替我设置管理员密码，也不要向我索要模型 API Key 或 Telegram Token，这些由我登录后在面板内填写。
```

:::tip 给 Agent 参考两份公开文件
你可以顺便把本站的 [Compose 模板](__DOCS_BASE__/examples/docker-compose.yml)、[最小配置](__DOCS_BASE__/examples/config.minimal.example.jsonc) 以及 [安装与首次登录](installation.md) 里的反代示例链接一并发给 Agent，减少它猜路径或写错字段的概率。
:::

## 2. 怎么处理 VPS 的初始 root 密码

VPS 服务商默认常只给 `root` 和一串初始密码，但尽量不要把明文密码直接粘贴到会长期保存的聊天记录里。推荐两种做法：

1. **优先：自己先配一次 SSH 公钥，再让 Agent 接手**。在你自己的终端运行一次下面两条命令（已有公钥可跳过第一条），只需要手动输入一次初始密码，之后 Agent 全程走密钥登录，完全接触不到密码：

```bash
ssh-keygen -t ed25519
ssh-copy-id root@<你的 VPS IP>
```

2. **如果确实让 Agent 用初始密码完成了首次登录**：等 Agent 帮你写入公钥、确认密钥能正常登录后，务必自己登录服务器改掉 `root` 密码（`passwd`），并在 `/etc/ssh/sshd_config` 里把 `PasswordAuthentication` 设为 `no` 后重载 SSH 服务，让留在对话里的初始密码立刻失效。

## 3. 过程中值得盯住的三件事

- **端口不要直接对外暴露**：`docker-compose.yml` 里只映射到 `127.0.0.1:8787:8787`，公网入口统一交给 HTTPS 反向代理。如果暂时没有域名，只靠本机 SSH 隧道访问，不要改成 `0.0.0.0:8787`。
- **容器内执行命令必须带 `-u surowan`**：`docker compose exec` 默认以容器内 root 运行，直接打开 `/data/surowan.sqlite` 可能留下 root 属主的临时文件，导致服务后续写库失败。生成一次性码必须使用 `-u surowan`。
- **配置文件权限**：非 Windows 宿主机要求配置目录为 `0700`、配置文件为 `0600`。官方镜像的入口脚本在每次启动时会自动修正 `/config` 与 `/data` 的属主和权限，宿主机裸跑则需要手动保持。

## 4. 拿到一次性码后，由你自己收尾

Agent 把面板地址和 `pwp_` 开头的一次性码交给你后，剩下的四步在浏览器里自己完成（通常两分钟）：

1. **打开面板**：配了域名就直接打开 `https://panel.example.com/`。没配域名先在本机开一条 SSH 隧道，再打开 `http://127.0.0.1:8787/`：

```bash
ssh -N -L 8787:127.0.0.1:8787 root@<你的 VPS IP>
```

2. **用一次性码登录**：在登录页点 **使用一次性码登录**，粘贴 `code` 登录。码默认 5 分钟过期，过期了让 Agent 再跑一次 `pairing create --web` 即可。
3. **设置持久凭据**：进入 **设置 → 管理员凭据**，设置新的用户名与密码（12–200 位）。如果已经配置了 `admin.public_url` 和 HTTPS，顺手到 **设置 → 通行密钥** 注册通行密钥（Passkey）。
4. **接入模型并测试**：到 **供应商** 添加模型接口和 API Key，再到 **模型** 选定主模型并保存，回到供应商页点 **测试** 确认返回正常（详细截图与步骤见[安装与首次登录](installation.md#5-接一个能正常回复的-agent-模型)）。

## 下一步

- 已经登录并接好模型：继续写[你的第一个人设](first-persona.md)，或直接按[你的第一只 Bot](first-bot.md)接上 Telegram。
- 想继续让本机 Agent 帮你查运行审计、调参数、改提示词：去[与 Agent 配合使用](agent-assisted.md)，一句话让它装好 `surowan-utils` CLI 和配套 Skill，用受控的客户端配对或 API 密钥协作，不再需要动用 `root` SSH。
- 想查看完整手工步骤和 Nginx / Caddy / Apache httpd 反代配置：见[安装与首次登录](installation.md)。
