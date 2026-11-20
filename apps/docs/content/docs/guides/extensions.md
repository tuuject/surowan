---
title: 使用 Skills、Plugin 与 MCP
description: 区分只读 System Skills、内置 Agent Plugin 和配置的 MCP Tool，并选择正确的调用方式。
---

# 使用 Skills、Plugin 与 MCP

这三类扩展都能让 Agent 获得额外能力，但来源、发现方式和安全边界不同。当前发行版内置 Plugin 包含 `web_fetch`、网络搜索（`web_search` 与七家服务商插件）、Alarm 与辞典；不要把本页当成插件市场或第三方扩展承诺。

## System Skills：只读操作说明

System Skill 是随 Surowan 发布的只读 Markdown 文档包。System prompt 只包含 Skill 索引，模型需要先用 `read` 读取 `system:///skills/<name>/SKILL.md`，再按文档使用 `execute` 调用内部能力。

Skill 是说明书，不是权限文件：不能绕过 Tool Schema、Conversation 引用校验、allowlist、预算或发送边界。运行时只允许读取 `system:///` 下的 Markdown，不能借此访问任意本地文件。

## 内置用户手册：让 Bot 读懂自己的文档

镜像随 `src/` 携带一份与本页同一来源的用户手册 Markdown（构建时从 `apps/docs/content/docs` 打包，含按导航生成的索引），Bot 通过两个内部能力按需读取：`list_documents` 返回可用文档空间与该空间的索引，`read_document` 按空间内相对路径读取单篇。整本手册不会预先放进 System Prompt；索引列出每篇的标题、路径与摘要，模型据当前任务挑页，单次读取上限 32 KiB。

运行时还会预先放入一份紧凑的产品意图索引，帮助模型把“不要理我”关联到 `/ignoreme` 等真实功能，再找到对应手册页。它由维护者从用户手册离线整理并随版本发布，普通部署无需安装 Coding Agent。索引不是完整手册，未收录不代表功能不存在。

你可以直接问 Bot 如何使用命令、修改配置、升级或排障；具体参数、权限和行为细节应先查当前版本手册。产品事实优先于角色扮演，语气仍可保持人格设定；普通闲聊不要求查文档。模型没有实际读取时不能声称“查过手册”，遇到缺失或版本不一致应说明不确定。文档是只读资料，不能扩大权限。当前只有内置的 `manual` 空间；用户自维护的文档空间尚未提供。

## 内置 Plugin：由运行时装配的能力

Plugin 是运行时随发行版装配的 Agent 扩展。模型通过 `execute` 的 search/help/call 发现和调用它们。

- `web_fetch` 执行无 Cookie、无认证 Header 的 HTTP(S) GET，并限制目标地址、重定向、响应类型、大小和超时；请求会优先声明接受 Markdown，支持内容协商的站点直接返回自己的 Markdown（可用 `web_fetch.accept_markdown: false` 关闭）；其他 HTML 页面默认抽取正文并转成 Markdown，Agent 需要原始 HTML 时才会显式请求。正文里的图片保留为带完整地址的 Markdown 图片链接，Agent 觉得画面内容确实重要时，可以再用 `web_fetch` 打开那张图片的链接：JPEG、PNG、WebP 会作为图片交给模型查看（单张最大 20 MiB，GIF、AVIF 等格式不支持），遇到防盗链时可以带上 `referer`（通常填所在网页的地址）。只有支持图片输入的模型才看得到画面，否则只会收到一段说明。它只做简单网页读取，需要 JS 渲染、登录或复杂解析时请接入 MCP。网页返回内容仍是不可信数据。
- `web_search` 提供内置网络搜索：在面板或 `web_search` 配置节里选择服务商、填地址与密钥，并给每个引擎写一条模型可见的备注。它只返回标题、URL 与摘要，正文仍由 `web_fetch` 读取；未启用时能力与 Skill 都不出现。配置方式、URL 正则过滤与热更新行为见 [网络搜索](./web-search.md)。
- Alarm 提供“稍后提醒”的 `alarm`、`list_alarm`、`delete_alarm` 能力。它创建持久任务，到期后生成完成回执：若同一会话已有可接收注入的运行，回执会在当前工具链结束后独立注入；否则等待可启动时开启新的运行。Agent 决定是否通过 `send` 跟进，而不是预先保存并自动发送一段话。它不是通用后台 worker，也不会执行任意外部任务。

使用任一内部能力前，模型应先读取相应 Skill（如果索引中提供），再 `execute.search`/`help` 了解参数，最后 `execute.call`。不要在配置中寻找“安装插件市场”的入口；当前没有这样的用户承诺。内置插件之间可以声明依赖与扩展点（例如每个搜索服务商都是一个依赖 `web-search` 的独立插件），但插件仍随发行版编译发布，用户侧只通过配置启用或调整。

## MCP：显式配置的外部 Tool

MCP Server 通过 `mcp.servers` 配置，可使用 stdio 或 Streamable HTTP。下面是局部片段（不是完整配置）：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "search",
        "transport": "stdio",
        "command": ["node", "server.js"],
        "tools": ["lookup"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 16384,
        "tool_policies": [
          { "name": "lookup", "read_only": true, "timeout_seconds": 20 }
        ]
      }
    ]
  }
}
```

`tools: "*"` 时使用 `default_tool_policy`；显式列出的 Tool 必须各有策略。没有策略的 Tool 不会暴露给模型。HTTP MCP 禁止重定向，凭据应使用 SecretRef Header，而不是 URL 参数。MCP Tool 不经 `execute` 注册表；它们以哪种方式交给模型，由下一节的 `exposure` 决定。

### 直接暴露与渐进式暴露

每个 Server 可以单独选择 `exposure`：

- `"direct"`（默认，不写即是）：每个 Tool 都以 `<alias>__<tool>` 作为独立 Tool 交给模型，每次请求都带上完整定义。
- `"progressive"`：这个 Server 的 Tool 不进入 Tool 列表。模型只看到一个 `mcp` Tool，它的说明里列出所有渐进式 Server 的 alias、Tool 数量和 `description`；模型需要时用 `mcp` 的 `search` 找 Tool（中文、英文都可以搜）、`help` 读某个 Tool 的完整说明与参数，再用 `call` 调用。

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "notes",
        "transport": "stdio",
        "command": ["node", "notes-server.js"],
        "tools": "*",
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": { "read_only": true, "timeout_seconds": 20 },
        "exposure": "progressive",
        "description": "Personal notes: search, read and append notes by title or tag.",
      },
    ],
  },
}
```

Tool 多的 Server 适合渐进式：所有渐进式 Server 加起来只占 Tool 列表里的一个位置，不再挤占 61 个 Tool 的上限，也不会让每次请求都背着几十份 Tool 定义。代价是模型多一次查找，而且它一开始只能从 `description` 知道这个 Server 能做什么，所以渐进式 Server 应该写好描述（最多 1000 字）。没写描述时模型只能看到几个 Tool 名，Warnings 页会显示 `mcp_description_missing` 提醒。

描述可以手写，也可以让工具模型根据 Server 公布的 Tool 起草：在面板编辑 Server 时点「用工具模型起草」，或运行 `surowan-utils mcp-server describe <alias>`。起草是一次计费的工具模型调用，结果只是草稿，不会自动保存——确认或修改后，在面板保存，或用 `surowan-utils mcp-server update <alias> --set description=...` 写入。

渐进式不放宽任何权限：`mcp` 只能找到并调用这个 Chat 本来就能用的 Tool（按 Chat 绑定照常收窄），调用走与直接暴露相同的参数校验、只读策略、超时、大小限制和审计。审计里会有两条记录：外层的 `mcp`，以及真正被调用的 `<alias>__<tool>`。

### MCP Server 发布的 Skill

支持「MCP with Skills」扩展的 Server 可以同时发布 Skill（说明如何使用它的 Tool 的文档）。Surowan 在每次连接后发现这些 Skill，并逐个校验文件内容、大小和摘要，校验不通过的 Skill 会被丢弃，不影响 Server 的 Tool。模型通过 `read` 读取这些文档，只限这个 Chat 本来就能用到的 Server。它们来自外部 Server，只能说明如何使用该 Server 的 Tool，不能覆盖 Tool 约束或授权规则。

每个 Server 可以写 `skills: false`，让模型读不到它的 Skill；省略即开启。修改它不会重连 Server，下一次运行生效。Admin 的 MCP servers 页会列出每个 Server 的 Skill。

### 按 Chat 限定 MCP Tool

每个 `telegram.chats[]` 条目可以写一个可选的 `mcp` 数组，决定这个 Chat 能用哪些 Server 与 Tool：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "search",
        "transport": "stdio",
        "command": ["node", "search.js"],
        "tools": ["lookup"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 16384,
        "tool_policies": [{ "name": "lookup", "read_only": true, "timeout_seconds": 20 }]
      },
      {
        "alias": "notes",
        "transport": "stdio",
        "command": ["node", "notes.js"],
        "tools": ["append"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 16384,
        "tool_policies": [{ "name": "append", "read_only": false, "timeout_seconds": 20 }]
      }
    ]
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "mcp": [
          // 只拿到 search 的 lookup
          { "server": "search", "tools": ["lookup"] },
          // 换个策略：同一个 Tool 在这个群里按只读、短超时处理
          {
            "server": "notes",
            "tools": ["append"],
            "tool_policies": [{ "name": "append", "read_only": true, "timeout_seconds": 5 }]
          }
        ]
      },
      // 空数组：这个 Chat 完全没有 MCP Tool
      { "id": 42, "mcp": [] },
      // 不写 mcp：拿到全部 Server 与 Server 自己的设置（和以前一样）
      { "id": -1009876543210 }
    ]
  }
}
```

- `server` 必须是 `mcp.servers` 里的 alias，同一个 Chat 不能重复绑定；`tools` 只能从该 Server 暴露的 Tool 里选，写 `"*"` 表示它的全部；`tool_policies` 覆盖该 Tool 在这个 Chat 里的 `read_only` 与 `timeout_seconds`，名字必须在被选中的 Tool 里。
- 绑定只收窄，不改连接：命令、URL、环境变量与 Header 仍属于 Server。需要两种连接就配两个 alias（Tool 名因此是 `<alias>__<tool>`）。
- Playground 房间永远没有 MCP Tool。每个 Chat 单独检查 61 个 Tool 的上限与模型上下文窗口，不同 Chat 的集合互不影响。

### 在面板里管理

Admin 的「MCP servers」页（Manage → MCP servers）让运营者不碰 `config.jsonc` 就能管理出站 MCP：页面显示每个 Server 的实时状态（ready / connecting / degraded，含错误码）、连接摘要与它发现过的全部 Tool（含被 `tools` 设置隐藏的），每条改动保存后立即热应用。

- **新增**只接受 Streamable HTTP Server（alias、URL、Header 密钥、Tool 选择与策略）；stdio Server 运行的是宿主机上的命令，必须在服务器的 `config.jsonc` 里手工添加。
- **编辑**时 HTTP Server 可以改 URL 与 Header；stdio Server 只能改 Tool 选择、大小限制与策略——命令、环境变量与传输方式保持只读，页面会明确提示这些字段只在 `config.jsonc` 里维护。两种 Server 都可以改暴露方式与描述，编辑框里的「用工具模型起草」会把草稿填进描述框，保存前不会写入任何东西。
- **删除**要求先解绑：还有 Chat 显式绑定该 Server 时会返回绑定它的 Chat 列表；不写 `mcp` 字段的 Chat 继承全部 Server，删除后它们自动失去这个来源。
- 每个服务器的工具选择来自它的显式列表，或 `tools: "*"` 时来自它实际发现（advertised）的工具名。
- Chats 页每行的「MCP servers」入口设置该 Chat 的绑定：继承全部、完全关闭，或显式挑选 Server 并收窄 Tool。

保存会触发与手改配置文件完全相同的切换：受影响 Chat 正在跑的 Invocation 会被停下并续跑，对话框里会提前说明这一点。

## 何时生效和如何确认

`mcp.servers` 与每个 Chat 的 `mcp` 都可以热应用，不需要重启：在 Admin「Apply config file」或任何一次面板保存之后，新增的 Server 会被连接、删除的会被关闭、改过字段的会被替换，没改的 Server 保持连接。改变某个 Chat 能用的 Tool（删掉绑定、换 Tool 列表、改策略，或它用的 Server 被改）时，这个 Chat 正在跑的 Invocation 会被停下、该 Chat 的连续 Context 会被重建，然后自动续跑一次：模型看到的是新的聊天记录，会被告知这次是运营者改了 MCP 配置，并收到被停下时结果未知的 MCP Tool 名，避免重复副作用。只是新增 Server 或加宽 Tool 列表不会打断正在跑的对话，下一条消息就用上新的集合。只改 `exposure` 或 `description` 也不会重连 Server、不会打断任何对话：它们不改变 Chat 能用哪些 Tool，下一次 Invocation 起按新的方式交给模型。

启动不会因为 MCP Server 连不上而等待或失败：每个 Server 都在后台连接，连不上或校验不通过的实例显示为 `degraded` 并按退避重试，不影响其他 Server、启动与本次热应用。只有 `ready` 的 Server 会把 Tool 交给模型——Server 不可达期间它的 Tool 从下一次 Invocation 的注册表中消失，恢复后自动回来；Admin 的 Warnings 页在 `degraded` 期间显示 `mcp_server_unavailable` 警告（`starting` 不告警）。旧配置里的 `required` 字段已废弃且不再生效（启动、热应用、doctor 都不看它）：配置仍然能加载，`check-config` 与 Warnings 页会提示从哪些 alias 删掉它。

确认方式：在 Tool session 的工具列表里看这个 Chat 实际拿到哪些名称（直接暴露的 `<alias>__<tool>`，以及渐进式 Server 共用的 `mcp`），在 Tool call 审计里看参数、结果与策略；停跑与续跑会在日志里留下一条 `mcp_config_published` 事件（受影响 Chat、停掉的 Invocation、重建的 Context、续跑与跳过的原因）。内部 Plugin 的调用则在 `execute` 外层和内部能力层分别留下可关联审计。

先用 `check-config` 离线检查配置。仍不能定位时，获得管理员许可后再运行 `node src/cli.ts doctor --config <config.jsonc>`：它会连接 Telegram、Provider 与全部 MCP Server（连不上的只记为警告，不算失败），可能产生模型费用。不要把“模型看到了 Tool 名称”当作“调用成功”；继续参考 [排障](../operations/troubleshooting.md)。

## 常见误区

- Skill 是文档，不是插件安装器，也不能扩大权限。
- 内置 Plugin 与 MCP 不同：Plugin 随 runtime 发布；MCP 由管理员显式配置外部 Server。
- `web_fetch` 不是任意 HTTP 客户端，不支持 Cookie、认证 Header 或非默认端口。内网与环回地址默认拒绝；`web_fetch.dangerously_allow_all_ip_addresses: true` 会取消全部地址限制，让任何能触发 bot 的人借模型访问你的内网，只在完全信任这些人时开启。
- MCP Tool 没有默认的每日调用次数上限，但仍受配置的只读策略、超时、大小和审计约束。

相关页面：[配置文件](../configure/config-file.md)、[模型](../configure/models.md)、[CLI](../reference/cli.md)、[排障](../operations/troubleshooting.md)。
