---
title: 选择接口
description: 在 HTTP 接口、反向 MCP Server 与两套命令行之间选一条路，分清两种程序化凭据，并了解本节承诺什么、不承诺什么。
---

# 选择接口

塑料碗只维护一张管理接口表，再把它适配给四种调用方：浏览器里的管理面板、HTTP 接口、反向 MCP Server，以及两套命令行工具。本节记录程序能驱动的三个接口，外加人和 Agent 在 shell 里跑的那套 CLI。

这里写的都是站点构建自带的那个提交。页脚给出提交号；`GET /api/version` 给出你要连的服务器实际跑的版本。

## 先选接口

| 接口 | 入口 | 凭据 | 适合 |
| --- | --- | --- | --- |
| HTTP 接口 | `<面板地址>/api/…` | 面板 Session Cookie、`Authorization: Bearer pwk_…`，或 `Surowan-Signature` 签名请求 | 脚本、看板、CI，以及任何想直接掌握请求与响应的地方 |
| 反向 MCP Server | `<面板地址>/mcp` | 只接受 `Authorization: Bearer pwk_…` | 已经会说 MCP、希望一个动作一个工具的模型 Agent |
| 客户端 CLI（`surowan-utils`） | 你的本机 | 同样两种程序化凭据，存在本地 | 想读写又不愿手写 JSON 的编码 Agent 或运维者 |
| 服务端 CLI（`surowan`） | 服务器 shell | 文件系统权限 | 安装、首次登录、配对、备份、诊断 |

HTTP 接口是最大的面：面板上的每一个动作都是 `/api` 下的一条路由，另外两个程序化接口只是薄薄一层。反向 MCP Server 为每条路由生成一个工具，客户端 CLI 为每条路由生成一条命令，两者都来自同一张表，见 [MCP 工具目录](mcp-tools.md)与[客户端 CLI 命令目录](cli-commands.md)。

有两类东西刻意不开放给程序：

- **面板本身。** 浏览器路由、侧栏顺序、查询参数和前端本地状态都是实现细节，不是接口。
- **本节没写的东西。** 某条路由、字段、错误码或工具没有出现在这些页面里，就当它是内部实现，并预期它变化。

## 两种程序化凭据

两者都由同一张路由表和同一组[权限模式](http/index.md)判定，区别只在请求如何证明自己是谁。

|  | API 密钥 | 已配对的客户端 |
| --- | --- | --- |
| 请求头 | `Authorization: Bearer pwk_…` | `Authorization: Surowan-Signature v=1,client=…,ts=…,nonce=…,sig=…` |
| 磁盘上的秘密 | 密钥本身，存哪都行 | 永不出机器的 Ed25519 私钥（`client-key.pem`，`0600`） |
| 防重放 | 除 TLS 外没有——密钥本身就是通行证 | 每请求 nonce 加 ±300 秒时钟窗口 |
| 有效期 | 直到在面板里撤销或轮换 | 直到服务端撤销该客户端 |
| 创建方式 | 管理面板 →「API 密钥」 | `surowan pairing create` + `surowan-utils auth pair` |

配置文件或密钥库里放一个长期秘密可以接受时（监控脚本、CI 任务、内部工具），用 API 密钥。调用方是别人机器上的 Agent、不该持有整个账号共享的凭据时（社区 Agent 帮你调塑料碗就是典型），用配对客户端：配对码短期且一次性，私钥无法从客户端导出。

两种凭据都不能管理对方，也不能管理账号：`/api/auth/*`、`/api/api-keys*` 与 `/api/keychain*` 只留给已登录的面板 Session。

## 版本对应

`GET /api/version` 返回正在运行的构建：

```json
{ "version": "v1.2.3", "channel": "Release" }
```

`channel` 是 `Release`、`Staging` 或 `Develop`。源码 checkout 或未打标的构建报告 `Develop` 和基于提交的版本号，所以版本字符串同样不是行为承诺。

公开站点与镜像内置手册跟随源码提交，而不是发布标签；你部署的镜像可能比这一页旧，也可能更新。依赖某条路由、字段或错误码之前：

1. 对你准备驱动的服务器调用 `GET /api/version`。
2. 和本站页脚写明的提交对照。
3. 不一致时以正在运行的服务器为准，改读镜像内置手册中对应的页面（Agent 用 `list_documents` / `read_document`，人用仓库上的发布标签）。

## 哪些是文档承诺

以下可观察行为由本节记录，可以据此开发：

- `/api` 的路径布局、HTTP 方法、JSON 错误信封，以及 [HTTP 公共约定](http/index.md)列出的状态码；
- 四种权限模式，以及每条路由需要哪项授权，包括 `write+paid` 组合；
- `If-Match` 并发版本，以及冲突写入如何被拒绝；
- `limit` / `offset` / `as_of` 列表分页；
- 配对客户端的签名协议：请求头字段、规范化字符串、时钟窗口与重放拒绝；
- 每条路由的响应类型（JSON、字节流，或文本/事件流）；
- 反向 MCP 的工具名与协议版本；
- 客户端 CLI 的命令名；

以及每个接口页面写明的部分——不多一字。

## 哪些不是

以下不是文档承诺：数据库结构与迁移、模块与文件布局、内部 Prompt 组装、SPA 的路由、组件与本地存储键、日志行格式，以及 `/api/live/*` 事件流的载荷形状。未记录的行为可能存在、可能合理，但仍然可以随时改变。

只有写在文档里的行为才是被支持的。目前还没有长期兼容承诺：当保留一个错误抽象成为代价时，公开发布可能重命名路由、字段或错误码。真发生时会写进发布说明，并同步更新本节。

本站没有 OpenAPI 文档。接口目录背后的表只有方法、路径、权限、并发版本、确认要求与响应类型，没有请求体与响应 Schema；导出一份 SDK 或完整 OpenAPI 只会比手写页面描述得更少。

## 接下来读什么

- [HTTP 公共约定](http/index.md)——基路径、鉴权、权限、分页、错误与计费调用。
- [审计、续跑与导出接口](http/audit.md)——读取运行、续跑失败运行、下载媒体。
- [配置、闸门与工具管理接口](http/configuration.md)——所有会写 `config.jsonc` 的接口。
- [知识与闹钟数据接口](http/data.md)——Memo、辞典、群聊记忆、提醒与循环闹钟。
- [虚拟群聊与图片接口](http/playground-images.md)——虚拟房间与生图工作台。
- [MCP Server](mcp-server.md)——反向 MCP 端点、协议与资源。
- [服务端 CLI](service-cli.md) 与[客户端 CLI](client-cli.md)——两套命令行。
- [Invocation 预检与重放](replay.md)——不产生副作用的重新运行。
- [Telegram 命令](telegram-commands.md)——Bot 自己在群里回答的成员命令。
