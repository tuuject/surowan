---
title: 接入 Telegram 群组与 Topic
description: 创建 Bot，配置允许的 Chat、群聊消息可见性和 Forum Topic 范围。
---

# 接入 Telegram 群组与 Topic

`telegram` 是可选配置段：没有 Telegram Bot 时可以先不写它，服务会停用 Telegram，只运行管理面板与 [虚拟群聊](../guides/playground.md)。需要接入真实聊天时再按本节配置；也可以在管理面板的 Telegram 设置页保存 Token 后热启动连接。

## 创建 Bot 并保护 Token

Telegram 官方 FAQ 指引开发者通过 [@BotFather](https://t.me/BotFather) 创建 Bot，再连接自己的后端。把获得的 Token 仅注入 `TELEGRAM_BOT_TOKEN` 等受控环境变量，绝不贴到配置、日志、截图或 Agent 对话。

## 让 Bot 能看见需要的消息

私聊消息对 Bot 可见。群中，Telegram 的隐私模式会限制 Bot 接收的消息；官方 FAQ 说明关闭隐私模式或将 Bot 设为管理员时，Bot 可收到除其他 Bot 消息外的群消息。按你的最小权限需求在 BotFather/群设置中调整，再测试一条普通成员消息。

即使 Telegram 已投递，Surowan 仍只处理 `telegram.chats` allowlist 中的 Chat。它默认不处理其他 Bot 的消息。

## 配置一个私聊或群

在完整配置中添加 Chat ID：

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

- Chat ID 必须唯一且非零；私聊为正数，群/Supergroup 通常为负数。
- 不写 `topic_ids` 时允许该 Chat 的普通消息和全部 Topic。
- 写入非空 `topic_ids` 时只允许列出的正整数 Topic ID。
- Forum Topic 的对话与 Context 按 Chat + Topic 隔离；Memo Pad、模型与参与策略是 Chat 级，所有 Topic 共用。

修改 allowlist 后运行 `check-config`。新增与删除 Chat 都热应用：删除会停止该 Chat 的运行并拒绝其新消息（面板删除还会立即清除数据）；修改 Topic 范围后需要重启服务，变更未重启前仍可能出现 `chat_not_allowed`。

## 等多久再处理一批消息

Bot 不会逐条回复：一个 Chat（或 Topic）的第一条新消息到达后，Bot 先收集一小段时间，再把这一批交给模型。三个全局字段控制这段时间，单位都是秒，取值 0–300：

| 字段 | 缺省 | 作用 |
| --- | --- | --- |
| `bucket_window_seconds` | `15` | 最短等待：一批至少收集这么久。 |
| `bucket_bump_seconds` | `0` | 每来一条新消息，把结算时刻推迟到「这条消息到达后」这么久；`0` 不延长。 |
| `bucket_max_seconds` | 同 `bucket_window_seconds` | 最长等待：从这一批第一条消息算起，延长不会超过这个时间。 |

```jsonc
{
  "telegram": {
    "bucket_window_seconds": 5,
    "bucket_bump_seconds": 8,
    "bucket_max_seconds": 30
  }
}
```

上例中，一条孤零零的消息 5 秒后就交给模型；有人连续说话时，每句话都让 Bot 多等到这句之后 8 秒，但从第一句算起最多等 30 秒，之后的消息归入下一批。不写这两个新字段时就是原来的固定窗口，已有配置不用改。

- `bucket_max_seconds` 不能小于 `bucket_window_seconds`，否则 `check-config` 报错。
- 只有能触发 Bot 的消息会延长等待；其他 Bot 的消息、入群退群这类服务消息和单独的 Sticker（未开启 `sticker_trigger_enabled` 时）会被收进这一批，但不推迟它。
- Bot 正在处理上一批时，这一批会等它说完再按 `bucket_window_seconds` 起算，可能超过 `bucket_max_seconds`。
- 开启长生命周期运行时，`agent.context.idle_grace_seconds` 不能小于 `bucket_max_seconds`。
- 三个字段修改后都需要重启服务。

## 同一条消息只回复一次

默认情况下，Bot 显式引用一条消息回复后，不会再引用同一条消息追加回复，即使更换内容或改发贴纸、图片也不行；一组图片作为一次相册发送。新消息仍可正常回复，不同 Chat/Topic 互不影响。

发送还在进行或结果未知时同样阻止再次回复，避免网络超时造成双发；明确未发出或被 Telegram 拒绝的发送仍允许重试。若进程在发送途中崩溃，遗留的 `pending` 也不会因重启或等待而自动放行；可在管理面板检查发送审计，但不能把等待时间长当作未送达的证据。规则依据在线保留的发送审计，跨会话运行和服务重启有效，但不承诺审计清理后的去重。

此规则针对明确的引用回复，不对未引用消息的独立发言做语义或文本相似度判重。被拦下的文本或贴纸（包括原样重发一条已发出的回复）在本次运行内不得删掉引用或改换引用目标重投（重新搜索得到的同一张贴纸也算同一内容）——这类绕行会再次被拦（`send_bypass`），只有更换内容才能发出；本次运行结束后不再记住这次拦截，回复去重本身则始终生效。发送屏障与限流的拦截不算在内，内容稍后仍可原样重试；生成的图片不受此约束。

确需对同一消息多次回复时，可将 `agent.allow_reply_message_multiple_times` 设为 `true`（可选，默认 `false`，全局字段、无每群覆盖）：它会关闭上述按消息的引用回复去重，允许对同一显式目标多次发送；但不会绕过授权、预算、发送限流或回复合并等其它发送保护，也不会关闭图片重复交付与结果未知保护。该字段属于热更新：改完后在面板点击 **Apply config file** 显式应用，下一次 Invocation 开始生效；正在运行的 Invocation 继续按应用前的设置执行。

## 同一次运行不重复发送

模型偶尔会陷入循环，把刚发过的同一句话一遍遍再发。默认情况下，Bot 在同一次运行（Invocation）里不会再发出与已成功发送的消息完全一致的文本或贴纸（内容、格式与引用目标都相同）。此外，紧接着上一条成功发出的消息，也不能把同样的文本或贴纸换个引用目标（或去掉引用）再发一遍——这能防住「同一句话挨个回复不同的人」；只比较上一条，中间隔了别的消息后，同样的短句仍可在后面再次出现。换个说法不受影响。被拦下的发送不会到达 Telegram，也不占发送额度；同一次运行累计被拦超过 3 次时，Bot 会直接结束这次运行。发送失败（Telegram 明确拒绝）的消息仍可原样重试；生成的图片有自己的重复交付保护，不受这条规则约束。

这条保护与上面的「同一条消息只回复一次」相互独立：即使把 `agent.allow_reply_message_multiple_times` 设为 `true`，原样重复仍会被拦下。确需关闭时，将 `agent.send_duplicate_guard_enabled` 设为 `false`（可选，默认 `true`，全局字段、无每群覆盖），也可以在管理面板 Harness 页面切换。它同样属于热更新，显式应用配置后下一次 Invocation 生效。

## 没写文字的发送

模型偶尔会调用发送却没有给出文字，例如只指定了要回复哪条消息。`agent.send_empty_text_strategy` 决定怎么处理这种情况（可选，默认 `reject`）：

| 策略 | 行为 |
| --- | --- |
| `reject` | 退回这次发送并返回 `send_input_invalid`，模型需要补上文字再发。默认值。 |
| `silent_success` | 工具返回成功，但明确说明没有发送任何消息；Telegram 上不会出现内容，也不占发送额度。连续三次静默成功的调用会结束本次运行，避免模型用空发送空转；一次多条回复里只要有一条真正发出，就不算静默。 |
| `random_text` | 从 `send_empty_text_fallback_texts`（默认 `["……"]`）随机取一条，按纯文本实际发出。 |

```jsonc
{
  "agent": {
    // 可选，默认 "reject"；也可写 "silent_success" 或 "random_text"
    "send_empty_text_strategy": "random_text",
    // 可选，默认 ["……"]：random_text 每次随机选一条
    "send_empty_text_fallback_texts": ["……", "嗯", "啊这"]
  }
}
```

- `random_text` 的文本照常遵守引用回复、文本长度、空行和重复发送等规则；同一次运行里连续抽中同一条时，第二次会被当作重复发送拦下。
- 每条兜底文本必须是一行、含有非空白字符；贴纸、图片、文件和写了文字的发送不受任何策略影响。
- 旧字段 `agent.send_empty_text_fallback_enabled` 仍然可用：设为 `true` 时，在没有显式策略的情况下等价于 `random_text`，升级不会改变已有行为。两者同时存在时以显式策略为准。
- 也可以在管理面板 Harness 页面用「Empty-text sends」下拉框切换策略，并在「Fallback texts」里一行写一条兜底文本。这些都是全局字段、无每群覆盖，属于热更新，显式应用配置后下一次 Invocation 生效。

## 输入状态

模型决定接话且需要搜索等耗时处理时，可以显示“正在输入”。快回复直接发送，保持沉默时不显示。状态每 4 秒刷新，同一 Chat 和 Topic 的请求不重叠；每轮最长约 60 秒，本轮结束、空闲等待或中断时停止刷新，客户端已有状态可能再保留最多 5 秒。输入状态不保证最终一定有回复。

有人在群里 @ Bot 时，Bot 会立刻显示“正在输入”，不必等聚合窗口结束或模型读完上下文。状态在 Bot 发出消息、本轮结束或约 55 秒后停止；如果模型随后选择沉默，状态会持续到本轮结束，属于预期行为。只有 @ 会触发，回复 Bot 或命中关键词不会；暂停、休眠，以及被 [参与方式](../guides/participation.md) 挡在时段外的消息也不会显示。不需要时在 `telegram` 下设置 `"mention_typing_enabled": false` 并重启。

## 贴纸集

Bot 只会发送你允许的贴纸集里的贴纸。在管理面板 Telegram 分组的「Bot sticker sets」页管理它们，改动写入 `telegram.sticker_sets` 并立即生效，无需重启：

- **添加**：填写贴纸集名称或分享链接（`https://t.me/addstickers/...`）、一个昵称，以及可选的备注。Bot 会在后台从 Telegram 下载贴纸并逐个建立视觉索引，页面会显示同步与索引进度；需要已配置 Vision 模型。
- **备注**：写给模型看的使用说明，比如「调侃朋友时使用；严肃话题中避免」。模型挑选贴纸时会看到每个贴纸集的昵称和备注，并按备注选择合适的贴纸集。
- **编辑**：只能改昵称和备注，指向的 Telegram 贴纸集添加后不可更改；要换成别的贴纸集，请删除后重新添加。改名不会丢失已建立的索引，新内容在下一批消息时生效，正在进行的回复不受影响。
- **删除**：Bot 立即停止使用其中的贴纸。索引会保留，之后重新添加同一贴纸集时无需重新分析。

添加或删除贴纸集会中止正在进行的回复，让下一次回复直接看到新的贴纸列表；只改昵称或备注不会中止。

## 管理员命令与验证

`telegram.admins` 中的 Telegram 用户可以使用 `/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/allowlist`。`/rebuild_context` 只丢弃当前话题的连续 Context，不截断聊天记录，适合在调小模型 Context Window 后让下一次会话按新预算重新开始。名单由 `config.jsonc` 的 `telegram.admins` 字段管理，修改后可热应用，无需重启。先在目标 Chat 发送一条测试消息，检查 `serve_started` 后的审计记录；“Bot 在线”不等于消息被允许，也不等于模型一定发言。

`/allowlist` 把 Bot 当前所在的 Chat（通常是刚把它拉进的新群）追加进 `telegram.chats` 并立即生效，无需重启。它是唯一能在未列入 allowlist 的 Chat 里使用的命令，且仅限 `telegram.admins` 中的用户：非管理员的 `/allowlist` 会被静默忽略。

`/model` 查看或切换本群模型：`/model 序号` 写入本群的模型覆盖，`/model default` 恢复跟随全局。切换立即生效：本群仍在用旧模型的会话会被直接终止（它们正在处理的消息不会再得到回复，之前委派的任务不受影响），之后的消息由新模型处理；回执会说明终止了几个会话。

`/effort` 查看或设置本群模型的思考强度（thinking effort）：不带参数时列出当前生效模型接受的级别与当前级别，未覆盖的级别会标注“继承全局”；`/effort 级别` 只写该群 `telegram.chats[].thinking_level` 这一项覆盖并热应用，不动该群的模型覆盖，级别必须是当前模型接受的取值之一；`/effort default` 只删除这项覆盖，思考强度回到继承全局。非推理模型只接受 `off`。改动只对之后启动的 Invocation 生效，正在运行的会话继续使用旧值。

服务启动时会先处理停机期间 Telegram 积压的消息：其中 `/pause`、`/resume` 按消息顺序执行，仍需通过同样的管理员、Chat/Topic 与发送者校验，不补发旧命令回复。其他已识别命令（包括 `/allowlist`、`/model` 和自助忽略命令）只保留审计，不重放操作，也不会作为聊天内容交给模型；启动后需要重新发送这些命令。

任何成员都可以发送 `/whoami`，Bot 会回复发送者的 Telegram 数字 ID，可直接用于填写 `telegram.admins`。

## 自助忽略与恢复

在已允许的 Chat/Topic 中，用个人账号发送：

| 命令 | 效果 |
| --- | --- |
| `/ignoreme` | 将自己的 Telegram User ID 加入当前 Chat 的 `ignored_user_ids`，立即忽略之后的消息。 |
| `/unignoreme` | 将自己的 ID 从列表移除，立即恢复接收。被忽略时也可以使用。 |

不需要管理员权限；命令只修改发送者自己，作用于该 Chat 的全部 Forum Topic，不影响其他 Chat。可加 `@Bot用户名` 指明目标 Bot。结果写回 `config.jsonc`，重启后仍保留；重复发送同一命令不会重复加入 ID。匿名身份不能使用。

管理员也可以直接编辑 `telegram.chats[].ignored_user_ids`（唯一的正安全整数数组），然后在面板点击 **Apply config file** 热应用。被忽略后的普通消息、编辑和其他命令不进入模型；已有消息与 Context 不会追溯删除，Update 审计仍保留。若命令提示“已写入，但应用失败”，运行中仍使用旧配置，修复配置后重新发送命令或在面板应用。

若需限制群内唤醒时段，参阅 [参与方式](../guides/participation.md)。若希望普通群消息只偶尔唤醒 Bot、而不是每条都参与，参阅 [控制主动插话频率](../guides/proactive-replies.md)。
