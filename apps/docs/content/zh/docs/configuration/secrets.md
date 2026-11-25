---
title: 密钥与路径
description: 三种 SecretRef、配置文件旁的 key.json 密钥库、轮换与孤儿清理、解析失败的表现、文件权限与路径基准。
---

# 密钥与路径

配置文件可以被随意阅读、比对、贴给别人或交给 Agent 检查，因为它里面**没有明文密钥**，只有指向密钥的引用。这一页说明引用的三种写法、密钥存在哪里、出错时会发生什么，以及各类路径按什么基准解析。

## 三种 SecretRef

需要密钥的字段只接受下面三种对象之一，写字符串会被拒绝：

```jsonc
{
  "telegram": {
    // 1. 环境变量：由 Compose、supervisor 或 shell 注入
    "token": { "env": "TELEGRAM_BOT_TOKEN" }
  }
}
```

```jsonc
{
  "providers": {
    "gateway": {
      // 2. keychain：值在同目录 key.json 里，这里只写条目名
      "headers": { "X-Routing-Key": { "jar": "gateway-routing" } }
    }
  }
}
```

```jsonc
{
  "web_search": {
    "engines": [
      // 3. 外部命令：不经 shell，只执行这里写死的 argv
      {
        "id": "main",
        "provider": "tavily",
        "api_key": { "command": ["secret-tool", "lookup", "service", "surowan"] }
      }
    ]
  }
}
```

| 形式 | 值来自 | 备注 |
| --- | --- | --- |
| `{ "jar": "<name>" }` | 配置文件同目录的 `key.json` | 条目名 1–64 个字母、数字、`_` 或 `-`。 |
| `{ "env": "<NAME>" }` | 进程环境变量 | `.env.local` 与 `.env`（仅当前工作目录）也会被所有 CLI 子命令加载。 |
| `{ "command": ["<argv>", …] }` | 该命令的标准输出 | 不走 shell，只运行写死的 argv。 |

能写 SecretRef 的字段：`telegram.token`、`telegram.decision_gate.api_key`、`providers[].api_key` 与 `providers[].headers`、`mcp.servers[].env` 与 `headers`、`web_search.engines[].api_key`、`image.credentials`。

`command` 的边界：最多等待 5 秒，标准输出最多 4096 字节并只去掉一个末尾换行，子进程只继承最小环境变量集合（`PATH`、`HOME`/`USERPROFILE`、`TEMP`、语言相关变量等）。它每一步都可能失败，所以适合本地 `secret-tool` 这类工具，不适合慢速网络调用。

## key.json 与 Keychain

`key.json` 是配置文件旁边的命名密钥库，一个目录里的 `key.json` 只属于这个目录里的 `config.jsonc`。它的格式带版本号：

```json
{
  "version": 1,
  "entries": {
    "telegram": { "value": "…", "created_at": "2026-01-01T00:00:00.000Z" }
  }
}
```

（上面是结构示意，不是真实值，任何地方都不显示条目的值。）

- **名字就是身份**：配置里写 `{ "jar": "telegram" }`，改名等于换条目。名字可以重复被多处引用，一把密钥可以被 Token、Provider 和 MCP Server 共用。
- **原地轮换**：在面板「密钥」页点「轮换」，或让面板的密钥输入框改写一个只被当前位置使用的条目，都是替换同一个条目的值并保留 `created_at`。轮换会立刻触发一次应用，使用它的 Provider 重建连接、被它引用的 MCP Server 重连、Telegram 重新读取 Token、图片凭据重新解析。不需要重启，见[配置生命周期](lifecycle.md)。
- **孤儿只手动清理**：写入配置不再删除不再被引用的条目。面板「密钥」页把「配置文件」和运行中的配置都不引用的条目列为「未使用」，点「清理孤儿」才会删除，删除单个条目时被引用的条目会被拒绝。配置文件无法解析时，这两件事都会被拒绝，而不是按不完整的引用集合误删。
- **旧格式自动迁移**：旧版扁平的 `{ "<name>": "<value>" }` 会在 `serve`、`doctor` 与 `configure` 启动时原地迁移成新格式，条目名保留。其它读取路径遇到旧格式会报错并提示先跑一次上述命令。迁移是单向的，旧版本程序读不了迁移后的文件。
- **写入是原子的**：`key.json` 总是先写临时文件再 rename，读者只会看到旧文件或完整的新文件，写入前会拒绝符号链接。

## 文件与面板输入的区别

配置文件里永远只写引用，面板的密钥输入框则提供三种来源：「填入新密钥」「选用已有条目」「外部引用」（只读显示当前的 `env` 或 `command`）。

选择「填入新密钥」时：

- 明文只提交给服务器，写进 `key.json`，配置文件只多一个 `{ "jar": "…" }`。条目名按使用位置预填（Provider 别名、`telegram`、`search-<engine id>`、图片凭据名），重名会依次加 `-2`、`-3`。
- 如果该位置当前指向的条目只被这一处使用，就在原条目上轮换值，配置文件不变。若还被别处使用，则新建条目并把这一处改指过去，不会悄悄改变别的使用处。

面板从不显示条目的值，Keychain 页只有名字、创建时间和「被使用于」。

## 解析失败会怎样

SecretRef 只在真正需要时解析，所以失败是按用途体现的，不是统一拒绝启动：

| 位置 | 失败表现 |
| --- | --- |
| Provider `api_key`/`headers` | 应用失败，返回 `secret_unresolved`；运行快照保持旧配置，改好引用或条目后重新应用即可。 |
| MCP Server `env`/`headers` | 该 Server 发布为 `degraded` 并在后台重试，它的工具暂时不提供给模型。 |
| `telegram.token` | 连接状态变为配置错误（原因 `token_unreadable`），进程继续运行，面板与虚拟群聊照常可用。 |
| `web_search.engines[].api_key` | 这次搜索调用返回 `secret_unresolved`，其它引擎与其它工具不受影响。 |
| `telegram.decision_gate.api_key` | 这一批决策记录 `secret_unresolved`，并按「失败一律放行」把批次交给主模型。 |
| `image.credentials` | 应用失败（图片快照准备不出来），旧的图片配置继续生效；进程启动时则只记录一条 `image_service_warning` 并继续运行。 |

一个特例：`telegram.token` 解析出的值是**空字符串**时不算错误，而是「停用 Telegram」，与根本不写 `token` 等价。

`check-config` 只校验文件形状与跨字段规则，**不解析**任何 SecretRef，也不执行 `command`。真实可用性用 `doctor` 与面板里的健康检查验证。

## 权限

非 Windows 系统上：

- 配置文件必须是 `0600`，其父目录必须是 `0700`。`serve`、`doctor` 与每一次面板/命令写入都会强制检查，`check-config` 不检查权限。
- `key.json` 必须是 `0600`，否则读取失败。Docker 镜像的入口会顺手修正这两个文件的权限。
- `serve` 只在数据目录缺失时以 `0700` 创建它，既有数据目录的权限只由 `doctor` 检查。

Windows 上这些检查被跳过。

## 路径基准

两类路径的基准不同，容易写错：

| 路径 | 相对谁解析 |
| --- | --- |
| `agent.system_prompt_file`、`telegram.chats[].instructions_file` | **配置文件所在目录** |
| `key.json` | 与配置文件同目录，不可配置 |
| `data_dir`、`paths.database`、`paths.media_cache`、`paths.backups` | **进程当前工作目录**（Docker 镜像里是 `/app`） |

所以 Compose 部署里配置用容器内绝对路径（`/data/…`），Prompt 文件与 `key.json` 放在 `/config`，见[安装与首次登录](../guides/installation.md)。

Prompt 文件里 `<!-- … -->` HTML 注释会被剔除，不进入模型上下文，但配置哈希按原始字节计算，所以纯注释改动也会改变 `config_hash`。

## 安全边界

- `config.jsonc` 里本来就没有密钥，真正要保护、不能提交或公开的是 `key.json`。
- 报告错误时密钥会被脱敏，已解析的值与面板刚提交的值都会在写入错误信息、日志与 API 响应前替换成 `[REDACTED]`。短于 6 个字符的值不参与脱敏，因为那种长度会命中普通词句却保护不了什么。
- 仓库用 `.claude/settings.json` 的 `Read(**/key.json)` 拒绝 Claude Code 读取密钥文件，它只是那一侧的护栏，其他 Agent 与进程不受它约束。不要把 `key.json` 交给任何 Agent。
