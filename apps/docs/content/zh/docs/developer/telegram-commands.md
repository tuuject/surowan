---
title: Telegram 命令
description: Bot 命令的识别规则、成员与管理员权限、参数、Chat 与 Topic 作用域，以及成功和失败回复。
---

# Telegram 命令

Bot 自带一组控制命令。它们是**确定性回复**，不经过 `send` 工具、不进入模型，也不作为聊天消息入库；回复是对命令消息的直接回复（同一个 Forum Topic），失败只写日志。

## 识别规则

- 只认**消息正文**开头的 Telegram 命令实体：`/pause`、`/Pause`、`/pause@本Bot用户名` 都可以；`@` 后的用户名必须匹配这只 Bot，写成别的 Bot 会被忽略。
- caption 里的命令不算，编辑后的消息不会执行命令（`/ask` 也一样：编辑补上的 `/ask` 不触发）。
- 其他 Bot 账号发来的命令不算。
- 命令后面跟的文字，只有 `/model` 与 `/effort` 当参数解析，其余命令忽略。
- 命令只在该 Chat 已被 allowlist 接受时才会执行（`/allowlist` 是唯一例外，见下）。

服务会把这些命令注册成 Telegram 的命令菜单，顺序与 `/help` 一致。

## 权限

| 层级 | 谁能用 | 命令 |
| --- | --- | --- |
| 管理员 | `telegram.admins` 里的 Telegram 用户 ID（每次读取当前生效配置，改名单立即生效） | `/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/allowlist` |
| 成员 | 能识别出**个人账号**的发送者 | `/whoami`、`/ignoreme`、`/unignoreme` |
| 任何人 | 能触达这只 Bot 的发送者 | `/ask`、`/help`、`/status` |

匿名管理员（`sender_chat`）与频道身份对权限检查来说是「没有人」：它们拿不到管理员命令，`/whoami` 会回「无法识别发送者。」，`/ignoreme` 会要求用个人账号发送。只有 `/ask` 例外，它接受匿名管理员与频道身份。

管理员命令由发送者 ID 判定，不是「群主」或「Telegram 管理员身份」。非管理员发送管理员命令只会收到 `该命令仅对本 Bot 的管理员可用。`

## /help

```text
/ask — 显式唤起 Bot 回答这条消息
/help — 查看你可以使用的命令
/status — 查看当前模型、thinking effort 与本日 token 用量
/whoami — 查看你的 Telegram 数字 ID
/ignoreme — 让 Bot 忽略你在本 Chat 的消息
/unignoreme — 恢复 Bot 接收你在本 Chat 的消息
```

- 只列**发送者在当前 Chat 实际能用**的命令，按菜单顺序；管理员会多出一段：一个空行、`管理员命令：` 标题，再加七条管理员命令（这一段里不再重复标注「仅管理员」）。
- 识别不出个人账号时，`/whoami`、`/ignoreme`、`/unignoreme` 不出现。
- 被列入本 Chat `ignored_user_ids` 的成员仍能收到 `/help`，但只列 `/ask`、`/help`、`/ignoreme`、`/unignoreme`，并在末尾附一句 `你已让 Bot 忽略你在本 Chat 的消息，发送 /unignoreme 可恢复。`

`/help` 的权限与忽略状态都读当前生效配置，所以刚 `/ignoreme` 完再发 `/help` 就已经变了。

## /ask

成员显式唤起 Bot 回答这一条消息。它是一条**普通消息**：正文（含 `/ask` 前缀）原样入库，进入 Context，模型可以自己决定不发言。

- 支持 `/ASK`、`/ask@本Bot用户名`；只在正文开头识别，caption 不算，编辑补上的不算。
- 未知会触发条件：开了 `ask_only` 时，只有 `/ask` 能开或加入消息批次，批次是 0 秒窗口、只收这条消息、不留注意力窗口，也不顺带认领待发的 Bot 消息。没开 `ask_only` 时，`/ask` 像直接 @ 一样用正常聚合窗口，在活跃时段外打开或刷新注意力窗口。
- 私聊不受 `ask_only` 与参与闸门影响；暂停、休眠等闸门仍然生效。
- 用过 `/ignoreme` 的成员仍可发 `/ask`：这一条会保存并触发。继续对话要再发一次 `/ask`，或者先 `/unignoreme`。
- 匿名管理员与频道身份可用，其他 Bot 不可用。

参与与 `ask_only` 的完整语义见[为不同群和话题设置边界](../guides/chats.md)与 [Telegram 配置](../configuration/telegram.md)。

## 命令细节

### /status

列出本群模型（有昵称就用昵称）、思考强度与是否继承全局，本群今日 token 用量，全局今日用量与日预算百分比，以及读取/写入/缓存读取/缓存写入的分项；随后按情况补：`互动: 已暂停`、`参与模式：仅 /ask 唤起`、`互动: 活跃时段内` 或 `互动: 注意力窗口至 …`；最后是每个话题的 Context 行（消息数、保留 send 数、`head_seq`、上次 GC 时间或 `未 GC`）。

没有任何 Context 时显示 `Context: 尚未建立`。暂停状态下也会列 Context，但不再计算参与状态。

### /model

```text
/model            → 列出可用文本模型（每页 20 条，显示昵称或 provider / model）
/model 3          → 把本群模型覆盖设为第 3 条
/model page 2     → 翻页
/model default    → 清除本群覆盖，跟随全局
```

- 只列已注册、接受文本输入的模型；有 `nickname` 时只显示昵称，不泄露 provider 与 model ID。
- 切换会写入 `telegram.chats[<id>].provider/model` 并立即热应用，同时把思考强度重置为该模型最弱的一档。
- 切换后，本群仍在用旧模型运行的 Invocation 会被**直接终止**：它们正在处理的消息不会再得到回复，回执会说明终止了几个会话。这是管理员自己的决定，不会二次确认。
- 回执里还会列出同一次应用带进来的其它配置修改，以及仍需重启才生效的项数。

### /effort

```text
/effort           → 当前强度、当前模型接受的级别，以及改法
/effort high      → 写本群 thinking_level 覆盖
/effort default   → 删除这条覆盖，回到继承全局
```

- 级别取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，必须是**当前注册模型**接受的取值；非推理模型只接受 `off`。
- 只写 `telegram.chats[<id>].thinking_level`，不动本群模型覆盖。改动在**下一次 agent session** 生效，正在运行的会话继续用旧值。
- `default` 不需要模型存在，模型配置残缺时也能清掉卡住的覆盖。

### /allowlist

把当前 Chat 追加进 `telegram.chats` 并立即热应用：

- 已在白名单里 → `本群已在白名单中。`
- 成功 → `已将本群加入白名单，配置已立即生效。`，若一次性应用里还有需要重启的项，会追加条数。
- 写文件成功但应用失败 → `已写入 config.jsonc，但应用失败: …`，此时运行中仍用旧配置。

它是**唯一**能在未列入 allowlist 的 Chat 里使用的命令，且只对 `telegram.admins` 生效；非管理员的 `/allowlist` 被静默丢弃，没有任何回复。运行时配置应用不可用时回 `运行时配置应用不可用。`

### /ignoreme 与 /unignoreme

把自己的 Telegram 用户 ID 加进当前 Chat 的 `ignored_user_ids`（或移除），立即热应用：

- 生效后，之后的普通消息、编辑、@ 与回复都不再进入模型；`/ask`、`/help`、`/ignoreme`、`/unignoreme` 仍可达。
- 作用于该 Chat 的所有 Forum Topic，不影响其他 Chat；结果写回 `config.jsonc`，重启后仍在。
- 重复发送同一条命令不会重复加入 ID。
- 同样会报告「同时应用了配置文件中的其它修改」与待重启项数。

已有消息与 Context 不会追溯删除，Update 审计也照常保留。

### /pause 与 /resume

`/pause` 暂停本群互动：把本群所有仍在收集/排队、以及尚未注入的运行批次置为过期，取消尚未投递的任务回执，把排队中的 Invocation 标为中止，并中止本群正在运行的那一个（它们正在处理的消息不会再得到回复）。回执是 `已暂停本群互动，发送 /resume 可恢复。`

`/resume` 删除暂停记录，回 `已恢复本群互动。` 暂停期间收到的消息仍然入库，恢复后作为历史可见。

### /cut_topic

```text
/cut_topic
已切掉此消息及更早的历史，并清空该话题的连续 Context。
```

作用域是**命令所在的 Conversation（Forum Topic）**，其他 Topic 不受影响；命令消息本身也在切口内。同一条命令还做三件事：

- 写入只前进不后退的历史切口（晚到或重复投递的旧命令不会把历史带回来）。
- 中断该 Conversation 正在跑的 Invocation，再清空连续 Context——不这样做，运行中的会话仍会拿着切掉的历史继续回答，还可能把更小的 `head_seq` 写回去。
- 丢弃内存里的 transcript。

话题还没有任何入库记录时也会回复成功，因为它没有历史可切。

### /rebuild_context

```text
/rebuild_context
已终止当前 Invocation 并丢弃连续 Context；下一条消息会基于最近的聊天记录重新构建。
```

只丢弃**当前话题**的连续 Context，不移动历史切口、不删聊天记录。适合调小模型 Context Window 之后让下一次运行按新预算重建。它会先中止该话题正在跑的 Invocation，再递增 Context generation，让那次运行迟到的写入被拒绝。

没有入库的 Chat 回 `当前 Chat 尚未入库，无需重建连续 Context。`，话题没有 Context 时回 `当前话题还没有连续 Context，无需重建。`

### /whoami

回发送者的 Telegram 数字 ID，可以直接填进 `telegram.admins`。识别不出个人账号时回 `无法识别发送者。`

## 启动时的积压命令

服务启动时会先把停机期间 Telegram 积压的 Update 拉下来。其中：

- `/pause` 与 `/resume` 按 Update 顺序**重放**，仍需通过同样的管理员、Chat/Topic 与发送者校验；只有它们的状态必须熬过停机。
- 其余已识别命令（含 `/allowlist`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/help`、`/ignoreme`、`/unignoreme`）只留下审计记录，不重放操作，也不会当作聊天内容交给模型。启动后需要重新发送。
- 积压处理不补发任何命令回复，所以 `/pause` 重放了你也看不到「已暂停」。

## 排错

| 现象 | 原因 |
| --- | --- |
| 命令完全没反应 | Chat 未列入 allowlist（`/allowlist` 除外），或 Topic 不在 `topic_ids` 里 |
| `该命令仅对本 Bot 的管理员可用。` | 发送者 ID 不在 `telegram.admins`，或用了匿名/频道身份 |
| 回复「无法识别发送者」 | 匿名管理员或频道身份；换个人账号 |
| `已写入 config.jsonc，但应用失败: …` | 运行中仍是旧配置；修好配置后重发命令或在面板应用 |
| 被忽略后连 `/help` 都没回复 | 只有 `/ask`、`/help`、`/ignoreme`、`/unignoreme` 例外，且必须来自实时新消息 |

关于「Bot 在线但不回复」的完整分流见[排查启动失败和不回复](../guides/troubleshooting.md)。
