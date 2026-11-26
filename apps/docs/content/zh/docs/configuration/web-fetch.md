---
title: 网页读取配置
description: web_fetch 的三个开关：Markdown 协商、代理 fake-IP 放行与危险的全 IP 放行，以及图片拉取的格式、大小与 referer 边界。
---

# 网页读取配置

`web_fetch` 让模型按 URL 读取一个具体页面，把正文转成 Markdown 后返回。它没有总开关，能力始终挂在 Telegram 与虚拟群聊上，这一段只调整三个安全与协议相关的开关。

```jsonc
{
  "web_fetch": {
    "accept_markdown": true,
    "allow_proxy_synthetic_addresses": false,
    "dangerously_allow_all_ip_addresses": false
  }
}
```

三个字段都可省略，省略时的行为就是上面这份默认值。**整段都是重启生效**，它不在热更新白名单里，改完要在「设置」页应用配置，再重启服务（部署带 supervisor 时面板会给出「立即重启」）。

## 字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accept_markdown` | `true` | 请求头里带上 `text/markdown`，支持 Markdown 内容协商的站点（例如 Cloudflare 的 Markdown for Agents）会直接返回 Markdown，省掉本地 HTML 提取这一步。模型调用时传 `raw: true` 则该偏好不生效，按原始 HTML 取。 |
| `allow_proxy_synthetic_addresses` | `false` | 允许解析到 `198.18.0.0/15` 的主机名。这是 Clash、Surge 一类 fake-IP 代理的固定答案段；只有这类部署才该打开。 |
| `dangerously_allow_all_ip_addresses` | `false` | 跳过全部目的地址检查，于是回环、局域网与云厂商元数据端点都能访问。只给「自己部署、只抓自己服务」的单用户环境用。 |

### 为什么这两个放行是不同的东西

默认策略解析每个主机名，只要有一个地址属于非公网就拒绝，包括回环、私有网段、运营商级 NAT、链路本地（含 `169.254.0.0/16` 云元数据）、保留段、组播与 IPv6 的 ULA、链路本地、转换前缀等。

- `allow_proxy_synthetic_addresses` 只放开 `198.18.0.0/15`，而且**只对主机名解析结果生效**，直接写 `http://198.18.x.x/` 这种字面 IP 依然被拒。所以它只修「代理把域名答成 fake-IP」这一种情况。
- `dangerously_allow_all_ip_addresses` 关掉整张拒绝表，重定向之后的每一跳也不再检查地址。它不放开别的，非标准端口、URL 里的凭据与 `#` 片段仍然照旧拒绝。名字里的 `dangerously` 是认真的，在这台机器和它所在网络里能访问的服务，模型就能通过网页内容把它们当成可读资源。

## 始终生效的边界

与配置无关，下面这些一直成立：

- 只发 `GET`，只接受 HTTP(S)，只走默认端口（80/443），URL 不能带用户名、密码或 `#` 片段。
- 不发 Cookie，不带任何配置里的凭据。User-Agent 是 `Mozilla/5.0 Surowan/<version>`，让站点返回普通页面。
- 重定向最多 3 跳，默认策略下**每一跳都重新做地址检查**，所以「公网地址 302 到 127.0.0.1」这种绕法不成立（打开 `dangerously_allow_all_ip_addresses` 后地址检查本身不在了）。
- 只接受文本类（`text/*`、JSON、XML、JavaScript）与图片两类响应，其他二进制类型、非 `identity` 的 `content-encoding` 直接报错。
- GBK、Big5、Shift_JIS 这类非 UTF-8 网页，只要响应头、页面的 `<meta charset>` 或 XML 声明写明了编码，就能正常读取，个别坏字节显示为 `�`。什么编码都没写明、内容又不是 UTF-8 的页面会报 `invalid_text_encoding`，不会去猜编码。
- 正文结果上限 32 KiB，超出加 `[content truncated]`。HTML 原文读取上限 2 MiB（转换要读整页）。单次请求 15 秒超时，且不会超过 Invocation 的剩余时间。
- 返回内容一律包在「不可信网页内容」的提示里，可以引用，不能当指令或授权。

## 图片拉取

网页里的图片在 Markdown 里保留成图片链接（感叹号 + 方括号里的说明 + 圆括号里的 URL），不会被自动下载。要看图，模型需要再调一次 `web_fetch`，把图片 URL 传进来：

- 一次调用只返回一张图，作为附件交给多模态模型。
- 接受 JPEG、PNG、WebP，按**内容字节**嗅探，不信 `Content-Type`，SVG 与其它 `+xml` 仍按文本处理。
- 上限 20 MiB，超了直接报 `image_too_large`，不会返回半张图。
- 站点需要防盗链时，模型可以同时传 `referer`，值是一个绝对 HTTP(S) URL（不含凭据，`#` 片段会被丢掉）。

图片是作为附件交给当前 Agent 模型的一次输入，所以只有模型本身接受图片输入时，这次调用才有用。正文里的图片链接本身不占图片额度。

## 示例

内网自建服务较多、又要求严格隔离的部署，通常保持默认：

```jsonc
{
  "web_fetch": {
    "accept_markdown": true,
    "allow_proxy_synthetic_addresses": false,
    "dangerously_allow_all_ip_addresses": false
  }
}
```

如果你的出口是 fake-IP 代理、打开网页总是被报「解析到非公网地址」，只加 `"allow_proxy_synthetic_addresses": true` 这一行。

## 与其他段的关系

- 搜索只负责发现结果，读正文靠这里：见[网络搜索配置](web-search.md)。
- 网页读取的失败码与排障见[排查启动失败和不回复](../guides/troubleshooting.md)。
- 图片作为上下文输入的机制见[Vision 配置](vision.md)。

字段类型见[网页读取字段参考](fields-web-fetch.md)。
