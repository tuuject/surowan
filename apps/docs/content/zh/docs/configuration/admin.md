---
title: Admin Panel 服务配置
description: admin 段的监听地址、端口、会话有效期、静态目录与 public_url，以及启用开关、Passkey 依赖与重启要求。
---

# Admin Panel 服务配置

`admin` 段描述管理面板这个 HTTP 服务本身：绑哪个地址、监听哪个端口、会话活多久、前端从哪里读、面板对外的正式地址是什么。

这一段是**必填**的（整段不能省），但其中只有 `enabled` 是可选的。

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

## 字段

| 字段 | 说明 |
| --- | --- |
| `enabled` | 可选，缺省 `true`。写 `false` 就完全不启动面板服务。 |
| `host` | 必填。监听地址。容器里要写 `0.0.0.0` 才能通过端口映射访问；放在反向代理后面时更安全的写法是 `127.0.0.1`。 |
| `port` | 必填，1–65535。 |
| `session_ttl_hours` | 必填，1–720。登录会话的有效期（小时）。 |
| `static_dir` | 可选。面板前端构建产物的目录；省略时用镜像内自带的构建。 |
| `public_url` | 可选。面板对外的正式地址，必须是规范化的 origin（见下）。 |

### public_url 的限制

它不是一个自由填写的链接，而是一个**被校验的 origin**：

- 必须是 `https://`，或者本机调试时的 `http://localhost`；
- 不能是 IP 字面量（IPv4、IPv6 都不行），`localhost` 例外；
- 不能带用户名、密码、路径、查询参数或 `#` 片段；`https://panel.example.com` 与带尾斜杠的写法都接受。

它一旦写上，就同时决定三件事：

1. **Passkey 的依赖方 ID**：取这个 origin 的主机名。之前用别的域名注册的 Passkey 会显示为不可用，需要重新注册。
2. **浏览器写请求的来源**：面板的写操作要求 `Origin` 与它完全一致，所以只能从这一个地址打开面板来改配置（没写 `public_url` 时退化为「同主机即可」）。
3. **配对输出的面板地址**：服务器上用 `pairing create --web` 生成一次性登录码时，给出的链接就是它（没写时是 `http://127.0.0.1:<port>/`）。

没写 `public_url` 就没有 Passkey：Passkey 相关接口直接返回 `passkeys_disabled`，只能用密码登录。

## 生效方式

**整段都要重启**：`admin` 不在热更新白名单里，改完要在「设置」页应用配置文件，然后重启进程（部署带 supervisor 时面板会给出「立即重启」）。监听端口、会话有效期、静态目录和 Passkey 依赖方都在进程启动时固定下来。

`enabled: false` 是一个真正的「无面板」模式：面板服务不启动，进程只靠 Telegram 工作。所以有一个硬性检查——面板关闭且 Telegram 也没配置（无 token 或 token 为空）时，`serve` 直接拒绝启动，因为那样没有任何入口。

## 首次登录

面板没有网页建号入口。第一个管理员只能来自服务器：

- `pairing create --web`：生成一次性登录码，并在没有账号时自动建一个无密码的 `admin`，登录后再补设密码；
- `admin-account`：离线创建或重置账号，需要面板进程没在跑。

一次性码的用途分 `client` 与 `web` 两种，两个领取端点各认自己那种，不能互相串用。细节见[管理面板、密钥与访问安全](../guides/admin.md)与[服务端 CLI](../developer/service-cli.md)。

## 示例

只在本机通过 SSH 隧道访问、并挂了反向代理的部署：

```jsonc
{
  "admin": {
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 12,
    "public_url": "https://panel.example.com"
  }
}
```

这里省略了 `enabled`，它缺省就是开启。

## 与其他段的关系

- 面板的密码、Passkey、API key 与 Keychain 都不在这段里，属于账号与凭据数据（见[管理面板、密钥与访问安全](../guides/admin.md)）。
- 配置文件的权限（`0600`、父目录 `0700`）由 `serve` 与 `doctor` 检查，与 `admin` 段无关，见[密钥与路径](secrets.md)。
- 面板页面本身的功能（运行记录、批改、续跑、虚拟群聊）见[开发者参考](../developer/index.md)。

字段类型与范围见[Admin 字段参考](fields-admin.md)。
