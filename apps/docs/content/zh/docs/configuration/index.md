---
title: 配置文件入门
description: 配置文件放哪、严格 JSONC 接受什么、哪些段必填、怎么校验，以及从最小示例开始的顺序。
---

# 配置文件入门

这一页解决「文件本身」的问题：位置、格式、必填段、校验方式和下载。某个字段的确切类型与默认值看[配置字段参考](fields.md)，改动怎么生效看[配置生命周期](lifecycle.md)。

管理面板的 Providers、Models、Prompts、Chats、Harness tuning、Telegram、Developer 等页面保存时，写的就是这份文件；手改文件则是另一种入口，两者不冲突。

## 文件在哪

所有 CLI 子命令都必须显式给出 `--config <path>`，没有默认路径，也没有向上搜索配置文件：

```bash
node src/cli.ts serve --config /path/to/config.jsonc
```

Docker 模板把宿主机的 `./config` 挂到容器的 `/config`，所以容器内的配置文件是 `/config/config.jsonc`，`key.json` 与 Prompt 文件也放在同一个目录。

- 配置哈希是文件原始字节与所有 Prompt 文件内容的 SHA-256；`check-config` 输出、`serve_started` 日志与审计里的 `config_hash` 都是这个值。
- 手改文件不会被自动读取：没有文件监视器，改完要么在面板「设置」页点「应用配置文件」，要么重启进程，见[配置生命周期](lifecycle.md)。
- 非 Windows 系统上，`serve`、`doctor` 与每一次面板写入都要求配置文件权限为 `0600`、其父目录为 `0700`；`check-config` 只做内容校验，不检查权限。

## 严格 JSONC

文件是带注释的 JSON（JSONC），解析器允许 `//`、`/* */` 注释、尾随逗号与 UTF-8 BOM。除此之外它是严格的：

- **未知字段会被拒绝**，不是忽略。每个对象都是闭合的（`additionalProperties: false`），把 `bucket_windows_seconds` 这类拼写错误写进去会直接报错，并列出多余的键名。
- **`version` 必须是 `1`**。
- **不接受明文密钥**。`telegram.token`、`providers[].api_key` 与 `headers`、`mcp.servers[].env` 与 `headers`、`web_search.engines[].api_key`、`image.credentials`、`telegram.decision_gate.api_key` 这些位置只能写 SecretRef，写成字符串会被拒绝并列出字段路径，见[密钥与路径](secrets.md)。
- **`image` 段是唯一的软校验**：结构不合法时整段被剥离、图片生成按禁用处理，并产生一条警告，进程照常启动。其它任何段都不会这样降级。

## 必填段与最小配置

根对象只有这些字段必填：

- `version`（`1`）、`data_dir`、`timezone`。
- `providers`：可以为空对象 `{}`；模型可以之后在面板里添加。
- `retention`：`online_days`、`backup_copies`。
- `paths`：`database`、`media_cache`、`backups`。
- `admin`：整段必填；`host`、`port`、`session_ttl_hours` 必填，`enabled` 可省略（缺省 `true`）。

其余顶层段全部可选，省略即对应功能关闭或使用默认值。Telegram 整段可省略；`telegram` 段存在时，段内的 `process_bot_messages`、`bucket_window_seconds`、`chats` 必填，`token` 仍可省略（省略即停用 Telegram）。

最小可运行配置（只开管理面板，不接 Telegram，模型留到面板里加）：

```jsonc
{
  "version": 1,
  "data_dir": "/data",
  "timezone": "Asia/Shanghai",
  "providers": {},
  "retention": { "online_days": 30, "backup_copies": 7 },
  "paths": {
    "database": "/data/surowan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups"
  },
  "admin": { "host": "127.0.0.1", "port": 8787, "session_ttl_hours": 24 }
}
```

这份文件能直接 `serve` 起来：面板可用、虚拟群聊可用，但因为没有任何 Agent 模型，Bot 不会运行。首次登录见[安装与首次登录](../guides/installation.md)。

[下载最小示例](__DOCS_BASE__/examples/config.minimal.example.jsonc)；需要 Telegram、Provider、Vision、图片生成等完整写法时用[完整示例](__DOCS_BASE__/examples/config.example.jsonc)。

## 全部顶层段

有子字段的段在生成页里各有一页 `fields-<段>.md`，下表的每个手写页首也链到对应生成页。

| 段 | 必填 | 说明与人工解释 |
| --- | --- | --- |
| `version` | 是 | 当前只接受 `1`。 |
| `data_dir` | 是 | 运行锁与运行数据根目录。[数据路径与保留](storage.md) |
| `timezone` | 是 | 默认 IANA 时区，Chat 可单独覆盖。[配置字段参考](fields.md) |
| `telegram` | 否 | Token、消息批次时间、Chat/Topic、参与策略、入场闸门、贴纸集。[Telegram 配置](telegram.md) |
| `providers` | 是 | Provider 与显式启用的模型列表。[Provider 与模型定义](providers.md) |
| `agent` | 否 | 主模型、Prompt、预算、发送与 Context 策略。[Agent 配置](agent.md) |
| `vision` | 否 | 图片与 Sticker 分析模型。[Vision 配置](vision.md) |
| `tool_model` | 否 | 系统级辅助模型；省略则继承全局 Agent。[Tool Model 配置](tool-model.md) |
| `models_dev` | 否 | 添加模型时读取元数据的目录地址。[模型元数据目录](models-dev.md) |
| `image` | 否 | 图片生成凭据与模型。[图片生成配置](image.md) |
| `dictionary` | 否 | 辞典自动注入模式。[辞典配置](dictionary.md) |
| `web_search` | 否 | 内置网络搜索。[网络搜索配置](web-search.md) |
| `web_fetch` | 否 | 网页读取的地址与格式开关。[网页读取配置](web-fetch.md) |
| `mcp` | 否 | Bot 连接的外部 MCP Server。[外部 MCP 配置](mcp.md) |
| `admin` | 是 | 本地管理面板的监听地址与会话时长。[Admin Panel 服务配置](admin.md) |
| `developer` | 否 | 调试报文与思考过程记录。[调试记录配置](developer.md) |
| `retention` | 是 | 审计与调度数据保留、备份份数、已读警告保留。[数据路径与保留](storage.md) |
| `paths` | 是 | SQLite、媒体缓存与备份目录。[数据路径与保留](storage.md) |

## 示例不是默认值

仓库里的示例为了跑满功能会写很多数字，它们不是缺省值。真正的默认值有两个来源：Schema 上标注的 `default`（生成页标为「Schema 声明默认」，它只是给人和工具看的约定，加载器不会写进文件）和运行时代码里的常量（标为「运行时默认」，省略时解析代码实际使用的值，是否生效取决于解析范围）。示例里的数字两者都不是：

- `agent.daily_budget.max_tokens` 的运行时默认是 `1000000000`，完整示例写的是 `300000`（一个刻意保守的推荐值）。
- `agent.context.idle_grace_seconds` 的运行时默认是 `0`（一次批次一次运行），完整示例写的是 `30`。
- `telegram.bucket_bump_seconds` 的运行时默认是 `0`；`telegram.bucket_max_seconds` 的默认等于 `bucket_window_seconds`，而不是常量 15。
- `telegram.decision_gate` 关闭时的阈值默认 `0.57`、模型默认 `typesafe/jev-1.14`，这不是推荐值，改模型或改提问后需要重新观察。

逐字段的取值、默认与废弃标注看[配置字段参考](fields.md)与各段的分页。

## 校验与检查

改完先离线校验，再应用或重启：

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

成功时输出一行 JSON，含 `status`、`config_hash`、`warnings` 与 `image_enabled`。`warnings` 里能看到「Agent 三元组不全」「Vision 未配置」「`image` 段被剥离」「使用了已废弃字段」这类不阻止启动的问题。失败时向 stderr 输出一行带 `status: "error"` 与 `error` 的 JSON，并以退出码 1 结束，报错会指出具体的字段路径。

`check-config` 只读文件，不解析 SecretRef、不连接 Provider/Telegram、不检查权限，所以它通过不代表运行时一定可用；真实连通性用 `doctor`，见[排查启动失败和不回复](../guides/troubleshooting.md)。

需要机器可读的字段约束时直接下载 [JSON Schema](__DOCS_BASE__/config.schema.json)，它与本页、各段字段页来自同一份 `ConfigSchema`。
