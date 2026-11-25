---
title: 安装与首次登录
description: 用 Docker Compose 启动塑料碗，配置 Nginx、Caddy 或 Apache httpd 的 HTTPS 反向代理，用一次性码登录面板，再接上一个能正常回复的 Agent 模型。
---

# 安装与首次登录

这一页把一台空机器带到「面板已登录、Agent 有可用模型」。人格与 Telegram 在接下来的两页。

:::tip 想让本机 Coding Agent 通过 SSH 一条龙装好？
如果你刚拿到一台带 `root` 账号和密码的新 VPS，可以直接照着[AI 帮我部署](ai-deploy.md)把整套流程交给 Agent 执行。
:::

**需要准备**：一台长期在线的机器、Docker 与 Docker Compose、一个模型服务的 API Key 与接口地址。Telegram Bot 可以稍后再建。

**完成标准**：日志出现 `admin_started`，面板能登录并留有持久凭据，主模型保存成功。能在虚拟群聊跑出一次回复更好，但不是这一页的前置。

## 1. 下载两个文件

```bash
mkdir -p surowan/config surowan/data
cd surowan
```

| 文件 | 保存为 |
| --- | --- |
| [Compose 模板](__DOCS_BASE__/examples/docker-compose.yml) | `docker-compose.yml` |
| [最小配置](__DOCS_BASE__/examples/config.minimal.example.jsonc) | `config/config.jsonc` |

最小配置不写 Telegram，也不预置供应商，面板起来以后再添加，改动会写回同一个文件。Compose 模板使用 `ghcr.io/tuuject/surowan:latest`（稳定版）。想跑本站对应的源码提交，就自己构建镜像并把 `image` 换成自己的标签。

### 目录权限（非 Windows）

服务要求配置文件本身 `0600`、它所在目录 `0700`，不满足时 `serve` 与 `doctor` 都拒绝启动，而不是降级运行。

```bash
chmod 700 config data
chmod 600 config/config.jsonc
```

官方镜像的入口脚本启动时会再次整理 `/config` 与 `/data` 的属主和权限，所以在 Docker 里通常不用手动执行。宿主机运行时必须自己保证。Windows 上没有这项检查。

## 2. 启动并确认面板

模板里的 `ports` 段默认是注释掉的。最小配置已经把 `admin.host` 写成 `0.0.0.0`，取消注释即可把端口发布到本机回环：

```yaml
    ports:
      - "127.0.0.1:8787:8787"
```

```bash
docker compose up -d
docker compose logs -f plasticwan
```

日志是一行一条 JSON。看到 `admin_started`（带 `host` 与 `port`）说明面板已经在监听。`serve_started` 里的 `mode` 此刻是 `disabled`、`bot_id` 为 `null`，因为还没有 Telegram Token，这是正常状态。

## 3. 在服务器上生成一次性码

面板没有网页建号页，第一次登录必须使用一次性码，且只能从服务器 shell 生成：

```bash
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
```

输出是 JSON，里面几项值得看：

- `code`：`pwp_` 开头的一次性码。
- `pairing.expires_at`：过期时间。默认 5 分钟，可用 `--ttl-seconds` 设到 60–3600 秒。
- `account`：实例上还没有管理员时，这条命令会顺手创建一个没有密码的 `admin`，这里会写 `"created": true`。
- `next`：面板地址与下一步提示，没配 `admin.public_url` 时是 `http://127.0.0.1:8787/`。

这条命令与运行中的服务共存，不需要停 Bot。想撤销一个没用的码，用 `pairing list` 找到编号再 `pairing cancel <编号>`。号码只能使用一次。

## 4. 登录并设置凭据

1. 打开 `http://127.0.0.1:8787/`。
2. 登录页默认是用户名与密码表单，点 **使用一次性码登录**。
3. 粘贴 `code`，点 **登录**。

新实例上这会以 `admin` 登录，而这个账号还没有密码。初始状态刻意做成和已在用的实例一模一样，所以别人看不出哪台是刚部署的，也因此不存在「先扫到就能抢先建号」的网页入口。

登录后到 **设置 → 管理员凭据**：填新用户名（3–32 个字母、数字、点、下划线或连字符）与新密码（12–200 个字符），点 **更新凭据**。其他浏览器上的登录会同时退出。

![登录页的「使用一次性码登录」表单](__DOCS_BASE__/screenshots/installation/sign-in-one-time-code.zh-CN.light.png)

## 5. 接一个能正常回复的 Agent 模型

1. 打开 **供应商**，点 **新建供应商**。
   - 内置供应商：只需填 API 密钥。
   - 自定义接口：填接口地址（通常以 `/v1` 结尾）、接口格式（不确定就选 OpenAI (Chat Completions)）和 API 密钥。
2. 点 **获取模型列表**，勾选要启用的模型，点创建。取不到列表时可以用 **手动添加** 按模型 ID 查询参数。
3. 打开 **模型**，在 **主模型** 卡片里选刚加入的模型与思考强度，点右下角的 **保存**。
4. 回到 **供应商**，点模型行的 **测试**：结果显示 **正常** 并给出模型的回复原话，就说明这个模型真的能用。

![模型页：三项角色与底部保存栏](__DOCS_BASE__/screenshots/models/model-roles.zh-CN.light.png)

主模型只要求能读文字，图片识别是另选的可选角色，不影响这一步。元数据补全、昵称、批量健康检查以及换模型时会发生什么，都在[接入和更换模型](models.md)。

## 6. 可选：公网地址、HTTPS 反向代理与通行密钥

面板本身只提供明文 HTTP 且建议只监听本机回环（`127.0.0.1:8787`），远程访问靠 SSH 隧道或你自己管理的 HTTPS 反向代理。要从公网安全访问并启用通行密钥（Passkey），需要给面板配一个固定来源：

```jsonc
{
  "admin": {
    "public_url": "https://panel.example.com"
  }
}
```

`public_url` 必须是规范的 HTTPS origin，不能带路径、查询参数、用户名或片段，也不能是 IP 地址（本机开发可以用 `http://localhost`）。不要把面板挂在站点子目录（例如 `/panel/`）下，面板静态页、`/api` 与 `/mcp` 都假定位于根路径。它是 WebAuthn 的 RP，换了域名就要重新注册通行密钥。

反向代理需要同时满足三项约定：

1. **放宽请求体上限**：图片上传等接口最大接受 30 MB，建议把代理上限设为 35 MB 左右。
2. **不对 `/api/live/` 缓冲并拉长超时**：运行记录的自动刷新走 Server-Sent Events（SSE），服务端每 15 秒发一次心跳，代理不能把流攒在缓冲区里，也不要在几十秒后切断长连接。
3. **透传原始 `Host` 与 HTTPS 协议头**：确保浏览器访问的来源与 `admin.public_url` 完全一致，登录 Cookie 会自动附带 `Secure` 标记。

下面三份示例均假设塑料碗发布在 `127.0.0.1:8787`，域名为 `panel.example.com`（请替换成你自己的域名与证书路径）。

### Caddy（自动 HTTPS）

Caddy 会自动向 Let's Encrypt 申请并续期证书，配置最短。写入 `/etc/caddy/Caddyfile` 后重载 Caddy 即可：

```text
panel.example.com {
	reverse_proxy 127.0.0.1:8787 {
		# 对 /api/live/* 等 SSE 实时流即时刷新，不攒缓冲
		flush_interval -1
	}
}
```

### Nginx

需要先准备好 TLS 证书（例如用 Certbot 签发到 `/etc/letsencrypt/live/panel.example.com/`）。写入 `/etc/nginx/sites-available/surowan.conf`、启用站点后执行 `nginx -t && systemctl reload nginx`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    # 图片上传接口最大接受 30 MB，略留余量
    client_max_body_size 35m;

    # SSE 实时流（运行记录自动刷新）：关闭缓冲并拉长读超时
    location /api/live/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

### Apache httpd

先启用所需模块（Debian / Ubuntu 可执行 `a2enmod ssl proxy proxy_http headers`），再将以下虚拟主机保存为站点配置并重载 Apache：

```apache
<VirtualHost *:80>
    ServerName panel.example.com
    Redirect permanent / https://panel.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName panel.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/panel.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/panel.example.com/privkey.pem

    # 覆盖最大 30 MB 图片上传（约 35 MiB）
    LimitRequestBody 36700160

    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader set X-Forwarded-Proto "https"

    # SSE 实时流：即时刷新数据块并拉长超时
    ProxyPass        /api/live/ http://127.0.0.1:8787/api/live/ flushpackets=on timeout=3600
    ProxyPassReverse /api/live/ http://127.0.0.1:8787/api/live/

    ProxyPass        / http://127.0.0.1:8787/ timeout=120
    ProxyPassReverse / http://127.0.0.1:8787/
</VirtualHost>
```

`admin.*` 属于需要重启的字段（类型与默认值见 [`admin` 字段参考](../configuration/fields-admin.md)）。改完 `public_url` 后执行 `docker compose restart plasticwan`，再从配置的这个 HTTPS 来源打开面板，在 **设置 → 通行密钥** 里 **添加通行密钥**。之后登录页会出现 **使用通行密钥登录**。反向代理后所有访客共享回环地址，密码防暴力破解按 TCP 来源地址计数，建议尽快注册通行密钥避免被他人误触发密码锁定。

## 7. 可选：离线建号与恢复（需要停机）

忘了密码又没有通行密钥时，用服务端的 `admin-account`。它直接改数据库，所以必须先停服务（`docker compose stop plasticwan`），否则会被运行中的实例拒绝。

```bash
docker compose run --rm plasticwan admin-account --config /config/config.jsonc --username <name>
```

终端会隐藏输入并让你重复一次新密码。非交互环境用 `--password-stdin` 从管道读，不要写在命令行参数里。每次执行都会注销该账号的所有登录 Session。Passkey 默认保留，加 `--revoke-passkeys` 才会一并删除。完成后重新 `docker compose up -d`。

## 8. 不用 Docker：宿主机安装

适合已有进程监督器、或者要跑未发布提交的部署。需要 Node.js 24 或更高、FFmpeg/FFprobe 与 Python（媒体转换用），以及可写的数据目录。

```bash
git clone https://github.com/tuuject/surowan.git
cd surowan
pnpm install --frozen-lockfile
pnpm run admin:build
pnpm run manual:prepare
cp apps/docs/examples/config.minimal.example.jsonc config/config.jsonc
```

- `pnpm install` 会连带构建工作区里的包。`admin:build` 生成面板静态文件。`manual:prepare` 打包 Bot 用 `list_documents` 读取的英文手册（不打包也能启动，只是没有这份手册）。
- 最小配置用的是容器内路径，宿主机要改成绝对路径，并把面板收回回环：

```jsonc
{
  "data_dir": "/srv/surowan/data",
  "paths": {
    "database": "/srv/surowan/data/surowan.sqlite",
    "media_cache": "/srv/surowan/data/media-cache",
    "backups": "/srv/surowan/data/backups"
  },
  "admin": {
    "host": "127.0.0.1"
  }
}
```

```bash
chmod 700 config data
chmod 600 config/config.jsonc
node src/cli.ts check-config --config config/config.jsonc
node src/cli.ts serve --config config/config.jsonc
```

`check-config` 只做离线校验，不连接模型或 Telegram。`serve` 起来后同样用 `pairing create --web` 登录，只是路径换成仓库里的 `node src/cli.ts`。生产环境的重启交给 systemd、容器平台或你自己的监督器，仓库不提供服务单元。

## 到这里应该看到

- 日志里有 `admin_started`，并且能打开 `http://127.0.0.1:8787/`。
- 用一次性码登录过，并在设置里留下了自己的用户名与密码。
- **模型** 页的主模型已保存，供应商页的 **测试** 返回了模型的原话。

接下来：[你的第一个人设](first-persona.md)。想先接 Telegram，也可以直接去[你的第一只 Bot](first-bot.md)，但先有可用的模型。

起不来、面板打不开、登录码报错时，先看[排查启动失败和不回复](troubleshooting.md)。
