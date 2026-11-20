---
title: 用入场闸门减少插话
description: 在消息批次交给主模型之前，用一个小的决策模型判断值不值得回复；先影子观察，再决定是否拦截。
---

# 用入场闸门减少插话

入场闸门（`telegram.decision_gate`）在消息批次到期、准备创建 Agent 运行之前，先让一个小的决策模型读一遍这批消息，判断 Bot 会不会想接话。它不替代人格提示词：真正说什么、怎么说仍然由主模型决定，闸门只负责不把明显不需要回应的批次交给它。

闸门默认关闭，关闭时行为与未配置完全一致。开启后也有两种模式：`shadow` 只记录判断结果，不改变任何调度；`enforce` 才会把被拒绝的批次关闭，不启动运行。

## 先观察，再拦截

建议的上线顺序：

1. 在全局段 `telegram.decision_gate` 写好 `api_key`，全局 `enabled` 保持关闭；选一个群，在它的 `telegram.chats[].decision_gate` 里把 `enabled` 设为 `true`，`mode` 保持 `shadow`。
2. 运行约一周，让它在真实消息上留下判断记录。`shadow` 不会让 Bot 少说话。
3. 用 `surowan-utils decision-gate decisions --chat <Chat ID> --limit 50` 导出判断记录，对照这段时间 Bot 的实际发言核对：被判断为「不送入」的批次里，有多少其实是该回的。
4. 再决定是否切到 `enforce`。可以先只把这个群的 `mode` 改成 `enforce`，确认效果后再推广到全局段。

`enforce` 下被拦下的批次以 `skipped_budget` 结束，错误码是 `decision_gate_dropped`；消息、修订与批次成员全部保留，之后仍会作为历史进入模型上下文。

## 哪些批次不经过闸门

以下情况直接按原有流程处理，不发送决策请求，也不写判断记录：

- 批内有 `/ask`、直接 @ Bot、回复 Bot 自己发过的消息，或命中配置的触发关键词。只要有一条，整批直接送入。
- 私聊。私聊没有「一批群消息」，配置了整个 `decision_gate` 对象会被 `check-config` 拒绝。
- 长程任务完成回执、管理员定义的循环闹钟、从面板恢复的 Invocation。
- 启动追赶（`startup_catch_up`）批次、Playground 房间，以及 send 屏障自己取走的批次。
- 被暂停、已离开配置、模型配置不完整或处于睡眠的 Chat。这些既有闸门先生效。

`ask_only` 的 Chat 只有 `/ask` 能开批次，所以它的批次全部是直接触发，闸门不会发出请求。

## 字段与默认值

`telegram.decision_gate` 是全局段；`telegram.chats[].decision_gate` 可以按字段覆盖前六项，未写的字段逐级回退到全局值，再回退到默认值。

| 字段 | 默认 | 层级 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `false` | 全局、Chat | 总开关。关闭时零影响。 |
| `mode` | `shadow` | 全局、Chat | `shadow` 只记录；`enforce` 拦截被拒绝的批次。 |
| `threshold` | `0.57` | 全局、Chat | 决策模型回答「是」的概率达到它才送入。 |
| `history_messages` | `10` | 全局、Chat | 随请求送出的更早消息条数，0–50；`0` 表示不带历史。 |
| `pending_messages` | `10` | 全局、Chat | 送出的批内消息条数，1–50。 |
| `instructions` | 见下 | 全局、Chat | 提问文本，支持 `{{ bot.name }}` 与 `{{ bot.username }}` 两个占位符。 |
| `model` | `typesafe/jev-1.14` | 仅全局 | 决策模型 id。 |
| `base_url` | `https://openrouter.ai/api/alpha` | 仅全局 | 必须是 HTTPS，不带凭据、查询参数或片段。 |
| `api_key` | 无 | 仅全局 | 密钥引用，只写 `{ "jar": "<条目名>" }`、`env` 或 `command`。 |
| `timeout_ms` | `3000` | 仅全局 | 500–10000；解析密钥与发出请求共用的总预算。 |

```jsonc
{
  "telegram": {
    "decision_gate": {
      "enabled": true,
      "mode": "shadow",
      "threshold": 0.57,
      "api_key": { "jar": "openrouter" }
    },
    "chats": [
      {
        "id": -1001234567890,
        "decision_gate": { "mode": "enforce", "threshold": 0.7 }
      }
    ]
  }
}
```

所有字段都是热更新，包括 `api_key`、`base_url` 与 `model`：保存后下一次决策就使用新值，不需要重启。Chat 覆盖保存后同样热应用；如果文件已写入但应用失败，面板会把文件值与运行值不同的字段标出来。

## 密钥

`api_key` 只写在全局段。它的规则与其它密钥相同：值存在 keychain（面板里叫「密钥」）中，配置文件只写条目名。已经配了 OpenRouter 供应商的部署可以直接引用同一个条目，不必再存一份。每次决策前都会重新读取条目，所以在「密钥」页轮换条目、改引用指向，都会在下一次决策生效，不需要重启。

- `enabled: true` 或任意一个 Chat 覆盖把 `enabled` 设为 `true`，都要求全局段写了 `api_key`；`check-config` 只检查字段在不在，不解析引用。
- 引用的条目不存在、环境变量未设置、外部命令失败或超时，都不会在加载时报错。闸门按「异常一律送入」处理并记一条 `secret_unresolved` 的判断记录，于是一个坏掉的密钥会让闸门静默失效，看起来像「一直在放行」。
- 因此开启闸门后务必运行 `node src/cli.ts doctor --config <config.jsonc>`。它会在闸门开启时解析密钥并发一次最小请求，连接失败会直接报错；输出不会包含密钥的值。

## 提问与阈值

判定固定为「P(是) ≥ `threshold`」，所以自定义提问必须仍然是一个是非题，并且「是」表示应当把这批消息交给主模型。默认提问问的是：Bot 作为群里的普通成员，读完这批新消息后会不会想回复。

修改 `instructions` 或 `model` 之后，`0.57` 这个默认阈值不再有依据；先用 `shadow` 重新观察一段时间，再决定新的阈值。请求只带一个问题是设计选择，不要把一个提问写成多个子问题或要求模型输出解释。

## 与主动回复、预算的关系

- 某个 Chat 的闸门处于 `enforce` 时，该 Chat 不再做主动回复抽样，避免「抽中后又被闸门抛弃」白白清空保底计数。`shadow` 不改变抽样。
- 决策请求的 Token 与花费不计入 `agent.daily_budget`。它不是免费调用，但不会让 Bot 因为预算而提前睡眠。
- 同一时刻最多 4 个在途决策请求，超出的批次直接送入并记录 `concurrency_limit`，不会排队。
- 请求超时、网络错误、非 2xx、响应形状不合法、模型拒绝回答，全部按送入处理，不重试。

## 在管理面板中编辑

全局设置在管理面板导航的「机器人 → 入场闸门」页（英文界面为 Agent setup → Entry gate）。页面分两块：

- **行为**：开关、模式、阈值、历史条数、批内条数、提问文本。「Use the default question」把提问清空，保存后会删除自定义文本，回到内置提问。
- **连接**：模型、地址、密钥与超时。密钥可以粘贴新的值（写入 keychain，条目名默认 `decision-gate`），也可以选用已有条目；当前使用的条目会显示在下方。任何响应与页面都不会回显密钥的值。

单个群的覆盖在 **Chats** 页：点该群所在行的「More actions」→「Edit entry gate」，每个字段都有「Set … for this Chat」开关。关闭开关表示继承全局值，保存时该字段会被删除；六个字段都关掉并保存后，整个覆盖对象会从配置里移除。私聊没有这个入口。

保存后立即热应用。配置在别处被修改时页面会提示重新加载，不会覆盖别人的改动。

## 验证

1. 运行 `node src/cli.ts check-config --config <config.jsonc>`，确认没有缺少密钥或地址不合法。
2. 开启闸门后运行 `node src/cli.ts doctor --config <config.jsonc>`，确认 `decision_gate` 是 `connected`。
3. 在面板保存，或点 **Apply config file**；下一次批次到期就按新模式处理。
4. 用 `shadow` 观察时，在 Tool sessions / Messages 里能看到批次照常产生 Invocation，同时审计中多出判断记录。用 `surowan-utils decision-gate decisions --chat <Chat ID>` 导出这些记录，核对 `outcome` 与 `probability`。
5. 切到 `enforce` 后，被拦下的批次结束于 `skipped_budget` 且没有新 Invocation；`scripts/audit.ts` 在排查「为什么不回复」时也会显示该批次的判断记录。
6. 日志事件名是 `agent_decision_gate`，包含 Chat、Conversation、模式、结果、概率与错误码，不包含消息正文。

相关页面：[控制主动插话频率](proactive-replies.md)、[参与方式](participation.md)、[Telegram 配置](../configure/telegram.md)、[CLI 参考](../reference/cli.md)、[排障](../operations/troubleshooting.md)。
