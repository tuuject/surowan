---
title: 外部 MCP 配置
description: 出站 MCP 的两种传输、工具 allowlist 与策略、上限、直接与渐进式暴露、Skills、后台建连与 degraded 降级、热应用与按群收窄。
---

# 外部 MCP 配置

`mcp.servers` 让塑料碗以 MCP 客户端身份连上外部服务器，把它们的工具交给模型，`telegram.chats[].mcp` 再把某个服务器的工具收窄到单个群。MCP 只在 Telegram 侧生效，虚拟群聊的执行档案里没有 MCP，配置了也不会在房间里出现。

这里的服务器是**出站**的（塑料碗去连别人）。塑料碗自己作为 MCP Server 对外提供工具是另一件事，见[服务端 CLI](../developer/service-cli.md)与 [MCP Server](../developer/mcp-server.md)。

## 生效方式

整个 `mcp` 段与每群绑定都是热更新，并且建连**永远不阻塞启动**：

- 进程启动时每个服务器在后台各自握手，连接失败只是把它标成 `degraded`（面板「不可用」）并按 1 秒起、逐次翻倍、最长 60 秒的退避重连。`serve` 照常进入调度与面板，哪怕所有端点都是黑洞。
- 连上并完成工具发现后状态变「就绪」，`degraded` 或「连接中」的服务器对新的 Invocation **不提供任何工具与 Skill**，恢复后的下一次 Invocation 自动拿回来。
- 处于不可用时面板有一条常驻警告 `mcp_server_unavailable`。`required` 被写进配置时另有一条 `mcp_required_deprecated`。渐进式服务器没写 `description` 时还有 `mcp_description_missing`。

改动如何生效，分三种：

1. **纯新增**（新服务器、更宽的绑定、给某个群加一个新服务器）：不碰任何上下文，下一次 Invocation 直接用更大的工具集。
2. **变窄或替换**（服务器离开配置、绑定收紧、某个被使用的服务器改了任一连接/工具/上限/策略字段、或它的 env/headers 里的密钥轮换）：走一次切换，先冻结受影响会话，中止正在运行的 Invocation，重建它们的 canonical Context，再换实例，最后为每个被中止且在回话的运行排一次续跑。原因是工具集属于 Conversation Context 的一部分，混着两套工具的上下文会写坏。
3. **只改展示方式**（`exposure`、`description`、`skills`）：不重连、不打断任何运行，下一次 Invocation 就用新值。它们只决定同一批工具怎么给模型看，不改变谁能调用什么。

服务器在面板里可以增删改（HTTP 传输），stdio 传输的连接字段（命令、参数、环境变量）只从配置文件读，面板里显示为只读。

## 传输方式

### stdio

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "fs",
        "transport": "stdio",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data/notes"],
        "env": { "LOG_LEVEL": { "jar": "mcp_fs_log" } },
        "tools": ["read_file", "list_directory"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 32768,
        "tool_policies": [
          { "name": "read_file", "read_only": true, "timeout_seconds": 30 },
          { "name": "list_directory", "read_only": true, "timeout_seconds": 15 }
        ]
      }
    ]
  }
}
```

- `command` 是 argv 数组，第一项是程序，直接 `spawn`（`shell: false`），不经过 shell，所以不用写引号转义，也不会有管道和通配符。
- `env` 的值是 SecretRef，与一份默认环境变量合并后交给子进程。
- `payload_max_bytes` 在这里是传输层单条消息的读缓冲上限。

### Streamable HTTP

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "issues",
        "transport": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "follow_redirects": false,
        "headers": { "Authorization": { "jar": "mcp_issues_token" } },
        "tools": "*",
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": { "read_only": false, "timeout_seconds": 60 }
      }
    ]
  }
}
```

- `url` 必须是不带用户名、密码与 `#` 片段的 HTTP(S) 地址（允许查询参数）。
- `follow_redirects` 必须写成 `false`，它是常量字段，不是可调开关。运行时任何 3xx 都被拒绝，服务器随即进入 `degraded`（错误码 `redirect_rejected`）。这是防止重定向把请求带去别处。
- `headers` 的值是 SecretRef，适合放 token。
- `payload_max_bytes` 在这里同时限制发出去的请求体和收到的响应体，超了标 `payload_limit` 并降级。

## 工具 allowlist 与策略

| 字段 | 说明 |
| --- | --- |
| `tools` | `"*"` 表示该服务器暴露的全部工具；也可以写成工具名数组，只暴露这些。 |
| `tool_policies[]` | 逐个工具的策略：`name`、`read_only`、`timeout_seconds`（秒，必须大于 0）。 |
| `default_tool_policy` | 通配符 `tools: "*"` 时必填的兼底策略，只有 `read_only` 与 `timeout_seconds`；也作为按群绑定的策略兼底。 |

校验规则（加载时就检查，不等到运行时）：

- `tools: "*"` 必须同时给 `default_tool_policy`，否则整份配置被拒绝，因为没有默认策略时任意一个工具都没有可用的只读标记与超时。
- 写成显式列表时，列表里**每个**工具都必须在 `tool_policies` 里有自己的条目，`default_tool_policy` 只给通配符 `*` 用，不会替显式列表里漏写的工具兼差。`tool_policies` 也不能引用没列出来的工具。
- 服务器返回重名工具、配置里点名但服务器没提供的工具、工具名拼出来超过 128 字符或含 `[A-Za-z0-9_-]` 之外的字符、以及声明「必须作为 task 运行」的工具，都会让这次连接失败（该别名进 `degraded`），不会静默少几个工具。
- 工具对模型的名字是 `<alias>__<tool>`，例如 `issues__create_issue`。

`read_only` 是审计与重试语义，不是权限。`false` 的调用在审计里标成有副作用，失败不会被当作可安全重试，只读调用遇到可重试的传输错误会自动重试一次。

## 上限

| 上限 | 值 | 触发时 |
| --- | --- | --- |
| `payload_max_bytes` | 1–1 048 576 | 见上面两种传输的说明；超限降级为 `payload_limit`。 |
| `result_max_bytes` | 1–32 768 | 工具结果截断后交给模型，末尾带 `[tool result truncated]`。 |
| 工具参数 | 固定 32 768 字节 | 拒绝调用（`arguments_too_large`），请求不会发出。 |
| 工具总数 | 固定 61 个（含 `mcp` 网关工具） | 某个会话的 MCP 工具集超出时，应用配置报错。 |
| 结果里的图片 | 每张 20 MiB | 转成附件后交给模型；失败则只留一条说明，不发送像素。 |

超时按 `timeout_seconds` 与 Invocation 剩余时间取小，每次工具发现另有 30 秒上限。

## 暴露方式与描述

`exposure` 决定同一批工具怎么进模型：

| 值 | 行为 |
| --- | --- |
| `direct`（缺省） | 每个工具都以 `<alias>__<tool>` 直接列进工具表，随每次请求发出完整定义。 |
| `progressive` | 工具不进入工具表；模型只看到唯一的 `mcp` 网关工具，用它的 `search` / `help` / `call` 在本群已授权的集合里按需发现与调用。 |

渐进式暴露适合工具很多的服务器，因为直接暴露的成本是每次请求都要带上全部定义，而且工具总数有 61 个的上限。网关的行为：

- 描述里列出这台服务器的别名、`description` 与工具数量。`description` 是写给模型看的「这台服务器能帮什么忙」，最长 1000 字符，可以用面板的「用工具模型起草」（计费）先写草稿再人工确认。
- 没写 `description` 时，网关只把这台服务器的前 8 个工具名列给模型，并触发 `mcp_description_missing` 警告。
- `search` 每次最多返回 10 条，`help` 返回单个工具的描述与参数 Schema，`call` 走的仍是同一套策略、超时、结果转换与审计，`tool_calls` 里记的是 `<alias>__<tool>`。

暴露方式不改变授权，渐进式服务器里的每个工具仍然受这台服务器的 `tools`、策略和本群绑定约束。

## Skills

`skills` 控制模型能不能读这台服务器发布的 Skill：

- **省略即开启**，写 `false` 关闭，关闭后工具照常可用，只是 `read` 不再提供 `mcp-skill://<alias>/<skill>/<path>`。
- 发现随连接进行，需要服务器声明 `io.modelcontextprotocol/skills` 扩展并提供 `resources/read`，否则这台服务器就是没有 Skill（`skills_error` 会说明原因）。
- 每个文件都要通过清单里的 sha256 与字节数校验，且全在 Skill 自己的根目录内，单文件上限 32 KiB、每个 Skill 最多 64 个文件、每台服务器最多 32 个 Skill、总计 1 MiB。任一不合格只会丢掉那个 Skill，不影响连接与工具。
- Skill 正文是外部数据，不可信，不能覆盖工具约束或授权规则。

## 与每群绑定的关系

`telegram.chats[].mcp` 只做**收窄**，不复制连接设置：

- 某个群没写 `mcp` → 它继承全部服务器（旧配置的行为），写 `mcp: []` → 一个都不给。
- 绑定里的 `server` 必须是已配置的别名。`tools` 只能选这台服务器暴露的工具。每个选中的工具都要能解析出策略（绑定自己的覆盖 → 服务器的条目 → 服务器的默认策略）。`tools` 写 `"*"` 时无法离线校验，改由连接后的发现结果核对。
- 连接设置（命令、URL、env、headers）留在服务器上。需要另一套连接就再配一个别名，不要在群里覆盖。

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "issues",
        "transport": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "follow_redirects": false,
        "headers": { "Authorization": { "jar": "mcp_issues_token" } },
        "tools": ["search", "create_issue"],
        "payload_max_bytes": 32768,
        "result_max_bytes": 16384,
        "default_tool_policy": { "read_only": true, "timeout_seconds": 30 },
        "tool_policies": [
          { "name": "search", "read_only": true, "timeout_seconds": 30 },
          { "name": "create_issue", "read_only": false, "timeout_seconds": 60 }
        ],
        "exposure": "progressive",
        "description": "团队 issue 跟踪：按关键词搜索已有工单，或在指定项目里新建工单"
      }
    ]
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "mcp": [
          {
            "server": "issues",
            "tools": ["search"],
            "tool_policies": [
              { "name": "search", "read_only": true, "timeout_seconds": 15 }
            ]
          }
        ]
      }
    ]
  }
}
```

这个例子给 `issues` 配了渐进式暴露与描述，然后让 `-1001234567890` 只拿到 `search`，并把它的超时收紧到 15 秒，其它没写 `mcp` 的群仍旧拿到 `search` 与 `create_issue`。

## 已废弃：`required`

`mcp.servers[].required` 仍被 Schema 接受，但**没有任何效果**，启动早就不等也不因 MCP 失败。写它会得到一条 `mcp_required_deprecated` 警告，建议删掉。它也参与「服务器是否变了」的比较，所以单纯增删这个字段不会触发重连、不会影响任何会话。

## 与其他段的关系

- 服务器页面、按群绑定与排障：见[开启搜索、定时任务与外部工具](../guides/tools.md)和[为不同群和话题设置边界](../guides/chats.md)。
- 密钥引用与 keychain 轮换：见[密钥与路径](secrets.md)。
- 群字段的完整说明：见 [Telegram 配置](telegram.md)。

字段类型与范围见[MCP 字段参考](fields-mcp.md)。
