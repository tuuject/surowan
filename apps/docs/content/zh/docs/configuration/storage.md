---
title: 数据路径与保留
description: data_dir、timezone、数据库/缓存/备份路径，retention 三个字段，serve 与 backup 的清理时机，以及清理什么、什么永远不会被清理。
---

# 数据路径与保留

这一页覆盖四块必填内容：根级标量 `data_dir` 与 `timezone`、`paths` 段、`retention` 段，以及它们背后的清理与备份行为。

```jsonc
{
  "version": 1,
  "data_dir": "/data",
  "timezone": "Asia/Shanghai",
  "paths": {
    "database": "/data/surowan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups"
  },
  "retention": {
    "online_days": 30,
    "backup_copies": 7
  }
}
```

## 根级标量

| 字段 | 说明 |
| --- | --- |
| `version` | 必填，当前只能是 `1`。 |
| `data_dir` | 必填。图片归档与素材数据的基础目录：`<data_dir>/images` 下是生图原图，另有 `playground/`（虚拟群聊素材）与 `memo-blobs/`（Memo 图片）。 |
| `timezone` | 必填，IANA 时区名（如 `Asia/Shanghai`），加载时用 `Intl` 校验。Chat 没写自己的 `timezone` 时用它，影响活跃时段、群聊记忆的日期边界、循环闹钟的默认时区、提示词里的时区变量与面板的时间显示。 |

路径按**进程工作目录**解析，不是按配置文件所在目录解析。容器里通常写 `/data` 这种绝对路径，相对路径可行但容易踩到启动目录，不建议。

## paths

| 字段 | 说明 |
| --- | --- |
| `paths.database` | SQLite 数据库文件。父目录不存在会以 `0700` 创建，文件在非 Windows 系统上会 `chmod 0600`。 |
| `paths.media_cache` | 图片转换用的临时目录：媒体需要转码时在这里建临时子目录，用完即删。停在服务时可以清空。 |
| `paths.backups` | `backup` 命令写备份的目录（不存在会以 `0700` 创建）。 |

Prompt 文件（`agent.system_prompt_file`、`chats[].instructions_file`）是例外，它们相对于配置文件所在目录解析，见[密钥与路径](secrets.md)。

## retention

| 字段 | 说明 |
| --- | --- |
| `retention.online_days` | 必填，正整数。审计与调度数据的在线保留天数。 |
| `retention.backup_copies` | 必填，正整数。`backup` 保留多少个备份文件。 |
| `retention.warning_read_days` | 可选，正整数，缺省 30。事件类警告被标记为已读之后再保留多少天。 |

### 生效方式

| 字段 | 生效方式 |
| --- | --- |
| `data_dir`、`timezone`、`paths.database`、`paths.media_cache` | 重启 |
| `retention.online_days` | 热更新，下一次清理（最长 24 小时后）就用新值 |
| `retention.warning_read_days` | 重启 |
| `paths.backups`、`retention.backup_copies` | 不影响运行中的服务，下一次 `backup` 读取 |

## 清理什么时候跑

保留清理只有两个触发点：

1. **`serve`**：启动时跑一次（在调度器开始工作之前，所以升级后第一次启动能安静地吃掉一大堆积压），然后每 24 小时一次。每次运行都读当前的 `retention.online_days`，所以热更新过的值会落到下一次清理。清理失败只记一条 `retention_cleanup_failed` 日志，定时器继续跑，进程不因此退出。
2. **`backup`**：在拷出 SQLite 之前先跑同一次清理，所以备份里不会带着已经超出保留窗口的审计数据。

事件类警告（`warnings`）另有一个小时级的清理线程，只删「已读且超过 `warning_read_days`」的行，未读警告不会自动消失。

### 会被清理

超出 `online_days` 的：

- 已经结束的 Invocation（`completed`、`failed`、`aborted`、`outcome_unknown`、`skipped_budget`）及其级联的 Agent transcript、模型调用、工具调用与发送记录，正在运行的、排队中的、以及被别的运行续跑的行不动。
- Bucket（含被合并或过期的），以及不再被引用的发送者行。
- 后台图片分析的缓存、没有挂到 Invocation 上的模型调用、群聊记忆的整理批次。
- 已结束且回执已处理的长任务、循环闹钟的历史触发记录、`daily_usage` 的旧日期。

还有一些行按各自的期限或窗口单独清理：

- Memo 条目（`expires_at` 到期即删，与保留窗口无关）、`conversation_attention`、`context_refs`，以及过期的一次性 nonce 与会话。
- 已使用、已取消或已过期的一次性配对码，它还要再等超过保留窗口才会被删。
- 虚拟群聊里仍被 Hold 但消息已超保留期的输入（标记为 `expired`，不静默删除请求键）。

### 永远不会被这两个窗口清理

- **聊天消息、消息 Revision、Media 行与 Conversation Context**：只随 Chat 或 Conversation 被删除（或显式截断）而消失。
- **原始 Telegram Update**：也保留在库里，不随保留窗口清理。
- Chat 配置、辞典词条、Memo 条目正文（除到期）、API key 与已配对客户端：都是身份性或用户数据，只有显式删除才消失。

## 备份里的图片

`backup` 产出的是**一对**文件：

```text
<paths.backups>/surowan-<时间戳>-<uuid>.sqlite
<paths.backups>/surowan-<时间戳>-<uuid>.images/     ← <data_dir>/images 的拷贝
```

- `.images` 目录是把备份文件名的 `.sqlite` 换成 `.images`，`<data_dir>/images` 不存在就跳过，拷贝失败只记日志、不影响 SQLite 备份的有效性。
- 两个快照之间没有跨存储的原子性，SQLite 快照之后提交的行，可能引用的是拷贝之前或之后那一版图片文件。恢复时把 `.images` 放回 `<data_dir>/images` 即可配套使用。
- 轮换按修改时间保留最新的 `retention.backup_copies` 个 `.sqlite`，并顺手删掉属于被轮换掉那些备份的 `.images/` 目录。升级前自动生成的 `pre-migration-*.sqlite` 只在同类文件之间轮换，但下一次 `backup` 的轮换不区分文件名，所以旧副本可能被一起清掉。
- 配置文件、Prompt、密钥**不在数据库里**，必须单独备份。

完整的备份与恢复步骤、隔离演练见[升级、备份与恢复](../guides/maintenance.md)。

## 示例

三个月审计、保留最近三份备份、仍用默认的警告保留期：

```jsonc
{
  "retention": {
    "online_days": 90,
    "backup_copies": 3
  }
}
```

## 与其他段的关系

- 配置文件自身的权限要求（`0600` / 父目录 `0700`）：见[密钥与路径](secrets.md)。
- `history_messages`、Context 的裁剪与 GC 是另一套机制，见 [Agent 配置](agent.md)。
- 面板「设置」页显示生效哈希与「需要重启」清单，见[配置生命周期](lifecycle.md)。

字段类型与范围见[保留字段参考](fields-retention.md)与[路径字段参考](fields-paths.md)，`data_dir`、`timezone`、`version` 这些标量在[配置字段参考](fields.md)里。
