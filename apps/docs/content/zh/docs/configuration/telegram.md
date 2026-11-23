---
title: Telegram 配置
description: 可选 telegram 段的语义：Token、消息批次时间、Chat 与 Topic、参与策略、主动回复、入场闸门、群聊记忆、按群 MCP 与贴纸集。
---

# Telegram 配置

`telegram` 是可选段。整段省略、或写了段但没有 `token`，都是「停用 Telegram」，进程照常启动，管理面板与[虚拟群聊](../guides/playground.md)可用，只是没有 Bot 连接。字段的完整类型、取值范围与默认值见 [`telegram` 段字段参考](fields-telegram.md)。

本页只解释跨字段约束与使用语义。日常接入的步骤在[你的第一只 Bot](../guides/first-bot.md)，参与与批次的调优在[按表现和费用调优](../guides/tuning.md)，每个群的规则在[为不同群和话题设置边界](../guides/chats.md)。

## Token 与连接状态

`token` 是 SecretRef，写成字符串会被拒绝。三种状态要分清：

- **停用**：没写 `token`，或它解析出的值是空字符串（例如环境变量设成空）。
- **配置错误**：SecretRef 取不到值（环境变量未设置、keychain 无此条目、命令失败）。进程继续运行，面板与群聊列表照常可用，但连接状态是 `config_error`、原因 `token_unreadable`，修好引用后在面板点「应用配置文件」即可，不需要重启。
- **已配置**：连接管理器用解析出的 Token 建立连接。

`token` 是热字段，轮换 keychain 条目或改成另一个 SecretRef，下一次应用就会让连接管理器跟上新 Token。

## 消息批次时间

Bot 不逐条回复。一条能开批次的消息到达后先收集一小段时间，再把整批交给模型。三个字段都是 0–300 的整数秒：

- `bucket_window_seconds`（必填，只有整个 `telegram` 段缺失时才有默认值 `15`）：一批**至少**收集这么久。
- `bucket_bump_seconds`（可选，运行时默认 `0`）：每条能开批次的新消息把结算时刻推到「这条消息到达 + 这个值」。
- `bucket_max_seconds`（可选，默认**等于 `bucket_window_seconds`**）：从这一批第一条消息算起的最长等待，延长不会超过它。

只有能触发 Bot 的消息会延长等待，其他 Bot 的消息、入群退群这类服务消息、以及未开启 `sticker_trigger_enabled` 时的单独 Sticker 会被收进这一批，但不推迟它。

跨字段约束（`check-config` 会报错）：

- `bucket_max_seconds` 不能小于 `bucket_window_seconds`。
- 开启长生命周期运行时（`agent.context.idle_grace_seconds > 0`），它不能小于 `bucket_max_seconds`，等于 `0` 表示关闭长生命周期运行，见[Agent 配置](agent.md)。

三个字段都是热字段，但只作用于**之后新开的批次**，正在收集的批次按开桶时的节拍走完，不会被临时改大或改小。三个省略两个的旧写法仍等价于固定窗口，因为 `max` 跟随 window 而不是常量。

## Chat 与 Topic 范围

`chats` 是允许范围的唯一事实源，只写 `{ "id": … }` 就能放行一个 Chat：

```jsonc
{
  "telegram": {
    "chats": [
      { "id": 123456789 },
      { "id": -1001234567890, "topic_ids": [100, 200] }
    ]
  }
}
```

- Chat ID 必须是非零安全整数且不重复：私聊是正数，群与 Supergroup 是负数。
- 不写 `topic_ids`：允许该 Chat 的普通消息和全部 Topic，写了就只允许列出的正整数 Topic ID。Forum Topic 的对话与 Context 按 Chat + Topic 隔离，Memo Pad 与 Chat 级设置由全部 Topic 共用。
- `timezone` 覆盖默认时区，参与时段按它解析，它是重启字段。
- `instructions_file` 指向该 Chat 的附加 Prompt，与全局人格叠加，路径相对配置文件目录。改内容或改路径都热应用，并让该 Conversation 的 Context 在下次运行时重建。
- `provider` / `model` / `thinking_level` 是每群模型覆盖，`provider` 与 `model` 必须成对出现，Topic 跟随所属 Chat。
- `ignored_user_ids` 是本群的忽略名单：这些成员的新消息与编辑只保留 Update 审计，不写入消息、不进 Context，实时新消息里的 `/ask`、`/help`、`/ignoreme`、`/unignoreme` 仍放行。名单可热应用，不追溯删除已有数据。

新增或删除 Chat 是热应用。删除会立刻拒绝该 Chat 的 Update 并停掉它正在运行的 Invocation，但**不删除**已存数据（面板/API 的删除才删）。Topic 范围变化、以及 Chat 的 `timezone`，都需要重启。

## 管理员

`admins` 是 Telegram 用户 ID 数组，也是 Bot 管理员白名单的唯一事实源，只有名单里的成员能执行 `/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/allowlist`。名单热应用，下一次命令执行就用新值。成员可用 `/whoami` 查到自己的数字 ID。面板「机器人管理员」页编辑的就是这个列表。

## 参与策略

`telegram.participation` 与 `telegram.chats[].participation` 把「任何可触发消息都开会话」收窄成「按时段活跃」：

- `active_windows`：每天重复的本地时段，`HH:MM` 到 `HH:MM`（结束可写 `24:00`），`days` 是 ISO 星期 1–7，省略表示每天。起止相同会被拒绝。
- `trigger_keywords`：命中消息正文或 caption 就算触发，大小写不敏感。
- `attention_window_seconds`：时段外命中一次后保持活跃的秒数，运行时默认 `300`。
- `ask_only`：为 `true` 时只有 `/ask` 能开批次，普通消息照常入库并进入群聊记忆，新批次是 0 秒且不留注意力窗口。

继承规则：Chat 写了 `active_windows` 就整体替换全局，`trigger_keywords` 追加到全局列表，注意力窗口长度按 Chat 覆盖全局。私聊不受影响，在正数 Chat ID 上配置 `participation` 会被 `check-config` 拒绝。

## 主动回复

`telegram.proactive_reply` 与每群覆盖决定「普通群消息有多少概率真的唤醒 Bot」。默认关闭，开启后每次批次到期先做一次概率抽样：

- `base_probability`（运行时默认 `0.2`）、`increment`（默认 `0.1`）、`hard_pity`（默认 `8`）：第 `attempt` 次连续抽样的概率是 `min(1, base + (attempt - 1) × increment)`，到达 `hard_pity` 必定命中。
- Chat 逐字段继承全局，私聊不能配置。
- 直接唤起（@、回复 Bot、命中关键词、Bot 命令、`/ask`）完全绕过抽样，也不动保底计数。
- 某个 Chat 的入场闸门处于 `enforce` 时，该 Chat 的抽样整体停用，否则抽中后又被闸门丢掉会白烧保底计数。

没抽中的批次记为 `skipped_budget`、原因 `proactive_reply_skipped`，消息不会删除。

## 入场闸门

`telegram.decision_gate` 在批次交给主模型之前，先问一个小的决策模型「这一批值得回复吗」。它是省费用与防刷屏的前置筛选，不是内容审核。

只在全局段配置连接参数，行为参数可以每群覆盖：

- 全局：`enabled`、`mode`、`threshold`、`history_messages`、`pending_messages`、`instructions`、`model`、`base_url`、`api_key`、`timeout_ms`。
- 每群 `chats[].decision_gate`：只有 `enabled`、`mode`、`threshold`、`history_messages`、`pending_messages`、`instructions` 六项，逐项继承全局。

关键约束与行为：

- `mode` 是 `shadow`（只记录，不改变调度）或 `enforce`（被拒绝的批次以 `skipped_budget`/`decision_gate_dropped` 关闭，不启动 Invocation）。默认 `shadow`。
- `enabled` 为 `true` 时必须提供 `api_key`，否则 `check-config` 直接拒绝，全局开启和 Chat 单独开启都算。
- `base_url` 必须是只含协议与主机的 HTTPS 前缀，不能带凭据、查询或片段，因为客户端只往后面拼 `/decisions`。
- `threshold`（运行时默认 `0.57`）与 `model`（默认 `typesafe/jev-1.14`）、`instructions` 是一组，改模型或改提问后，原来的阈值不再有可比性，需要重新用 `shadow` 观察。
- `timeout_ms`（默认 `3000`）是「解析凭据 + HTTP 请求」共用的预算。超时、网络错误、凭据解析失败等一切失败都**放行**批次，并记录原因，凭据解析失败见[密钥与路径](secrets.md)。
- 私聊不能配置 `decision_gate`（整段会被拒绝）。Playground 房间、启动追赶批次、任务回执、循环闹钟、面板恢复，以及直接触发（@、回复 Bot、关键词、`/ask`）都不经过闸门。

`decision_gate` 与每群覆盖都是热字段，每次决策都从当前发布的配置重新解析设置与凭据引用。

## 群聊记忆

`telegram.chats[].group_memory` 按群开启回忆能力，没有全局默认：

- `enabled` 必填。
- `idle_minutes`（运行时默认 `30`）：群安静这么久之后，后台把还没整理的本地日期消息交给**系统 Tool Model** 整理成带 message-id 区间的事件摘要，已经结束的日期不必等空闲。
- `thirty_hour_clock`：`off`（缺省）、`non_overlapping` 或 `overlapping`，只改变「按日期搜索」覆盖的本地时段：`off` 是当日 0–24 时，`non_overlapping` 是当日 6 时到次日 6 时，`overlapping` 是当日 0 时到次日 6 时，整理与归档仍按自然日。

整理用哪个模型由 `tool_model` 决定（省略则继承全局 Agent），见[Tool Model 配置](tool-model.md)。开关状态变化会中止该 Chat 正在运行的 Invocation 并重建 Context，关闭只停止后续整理，已写入的记忆与原文保留。

## 按群绑定 MCP

`telegram.chats[].mcp` 收窄某个 Chat 能用的外部工具，不复制连接设置（Server 本身的写法见[外部 MCP 配置](mcp.md)）：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "tools",
        "transport": "stdio",
        "command": ["example-mcp-server"],
        "tools": ["search_docs"],
        "payload_max_bytes": 4096,
        "result_max_bytes": 4096,
        "tool_policies": [{ "name": "search_docs", "read_only": true, "timeout_seconds": 10 }]
      }
    ]
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "mcp": [{ "server": "tools", "tools": ["search_docs"] }]
      }
    ]
  }
}
```

- `server` 必须是 `mcp.servers` 里已有的 alias，且在一个 Chat 里不能重复绑定。
- `tools` 省略或写 `"*"` 表示按 Server 自己声明的集合，写显式列表时每个名字都必须存在于该 Server（显式列表在配置校验时检查，`"*"` 的 Server 在发现阶段检查）。
- 每个被选中的 Tool 必须能解析出一条策略：绑定自己的 `tool_policies`、Server 的 `tool_policies`，或 Server 的 `default_tool_policy`。
- 绑定支持热应用，收窄（少一个 Tool、Server 消失或变化）会停掉该 Chat 的运行、重建 Context 后续跑，纯增宽不打断运行。

## 贴纸集

`telegram.sticker_sets` 是 Bot 允许发送的贴纸集列表，面板「贴纸集」页编辑的就是它：

```jsonc
{
  "telegram": {
    "sticker_sets": [
      { "alias": "cats", "name": "TelegramStickerSetName", "note": "调侃朋友时使用；严肃话题避免" }
    ]
  }
}
```

- `name` 是 Telegram 上的贴纸集名称，也是集合的身份，按大小写不敏感比较且必须唯一。加入后不能改指向，换集合只能删除再添加。
- `alias` 是昵称，只在已配置的集合之间唯一，模型在贴纸目录里看到它。
- `note`（可选，1–500 字符）写给模型看的使用说明，跟着目录一起注入。
- 整个列表支持热应用，增删集合会立即中止所有运行中的 Telegram Invocation，让下一次回复看到新列表，只改 `alias` 或 `note` 则不中止。
- 贴纸的视觉索引需要 Vision 模型，见[Vision 配置](vision.md)。

## 其他开关

- `process_bot_messages`（必填）：是否处理其他 Bot 的消息。`false` 时它们只留 Update 审计，`true` 时入库但永远不能创建批次，避免两个 Bot 互相唤醒。重启字段。
- `sticker_trigger_enabled`（可选，缺省 `false`）：单独的 Sticker 能否创建批次。重启字段。
- `mention_typing_enabled`（可选，缺省 `true`）：被 @ 且消息进入批次时立刻显示「正在输入」。重启字段。

## 生效方式

`token`、三个批次时间字段、`admins`、`sticker_sets`、新增/删除 Chat、每群的模型覆盖、`instructions_file`、`ignored_user_ids`、`participation`、`proactive_reply`、`decision_gate`、`group_memory`、`mcp` 与 `dictionary_injection_mode` 是热字段。`topic_ids`、`timezone`、`process_bot_messages`、`sticker_trigger_enabled`、`mention_typing_enabled` 需要重启。完整矩阵与失败处理见[配置生命周期](lifecycle.md)。
