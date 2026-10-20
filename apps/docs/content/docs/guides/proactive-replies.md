---
title: 控制主动插话频率
description: 用带保底的概率调度，让塑料碗偶尔主动加入群聊，而不是对每条消息都接话。
---

# 控制主动插话频率

默认情况下，allowlist 中的群聊遇到可触发消息就会开一个消息 Bucket，模型可以自己决定是否发言。对于热闹的群，这可能让塑料碗显得太爱插话。`proactive_reply` 给**普通群聊消息**加一道按群的概率闸门：只有被抽中的批次才会创建 Agent 运行，同时用连续未命中计数保证它不会因为运气差而永远轮不到。

概率调度只决定「要不要给一次运行机会」，**不保证模型一定发言**。被 @、回复 Bot 或命中触发关键词时属于直接唤起，不经过抽样。

## 开启并调整

下面是局部 JSONC 片段（不是完整配置）：

```jsonc
{
  "telegram": {
    "proactive_reply": {
      "enabled": true,
      "base_probability": 0.2,
      "increment": 0.1,
      "hard_pity": 8
    },
    "chats": [
      {
        "id": -1001234567890,
        "proactive_reply": {
          "base_probability": 0.1,
          "hard_pity": 12
        }
      }
    ]
  }
}
```

- `enabled`：总开关，默认 `false`。关闭时行为与未配置完全一致。
- `base_probability`：第一次尝试被选中的机会，默认 `0.2`（20%）。
- `increment`：每次未命中后增加的机会，默认 `0.1`（10 个百分点）。
- `hard_pity`：最多连续尝试次数；到此次数必定获得机会，默认 `8`。

全局 `telegram.proactive_reply` 提供默认值，`telegram.chats[].proactive_reply` 按字段覆盖。两个层级都不写时功能关闭。私聊不支持主动回复调度；在私聊 Chat 上配置会被 `check-config` 拒绝。

第 `n` 次连续尝试的机会是：

```text
n >= hard_pity ? 100% : min(100%, base_probability + (n - 1) × increment)
```

例如默认参数下依次是 20%、30%、40%……第 8 次必定命中。

## 哪些消息不受影响

以下直接唤起完全绕过概率调度，也不会增加或清零保底计数：

- 直接 @ Bot（文本或图片说明中的 mention）。
- 回复 Bot 自己发送过的消息。
- 命中 `telegram.participation` 或 `chats[].participation` 中配置的 `trigger_keywords`。
- Telegram Bot Command（例如 `/status`、`/pause`）。命令本来就不进入消息 Bucket。

暂停、休眠、allowlist、群组活跃时段等既有规则仍然先生效；概率调度只处理已经通过它们的普通消息。

## 计数与状态

- 计数按**群**隔离，同一群的 Forum Topic 共享一个计数。
- 每个完成聚合的消息批次最多抽样一次；批次里只要有一条直接唤起消息，整批直接放行。
- 命中后计数清零；未命中时批次不会创建运行，但消息照常保存，之后仍会作为历史进入模型上下文。
- 计数存在 SQLite（`proactive_reply_state`），服务重启不会清零。
- 修改 `base_probability`、`increment` 或 `hard_pity` 后，下一次抽样会把该群计数清零，避免旧进度让新参数立刻触发保底；仅关闭再开启功能或仅重启不会清零。

## 在管理面板中编辑

全局默认值在 Admin Panel 的 **Harness tuning** 页「Proactive replies」一组：打开或关闭调度，并设置首次机会、每次增加和最多尝试次数。这里的概率按 0–1 填写（`0.2` 即 20%）。没有自定义的群都跟随这里的值。

单个群的覆盖在 **Chats** 页，每行的星形按钮打开「主动回复概率」：

- **沿用全局设置**：删除本群覆盖，逐项继承全局值。
- **关闭主动回复**：本群只有直接叫到 Bot 的消息才会触发。
- **自定义本群参数**：用三个数字框设置第一次机会、每次增加和最多尝试次数。界面按百分比显示，不需要写小数。

保存后立即热应用，不需要重启。列表的「主动回复」列显示当前生效的摘要。

## 验证

1. 运行 `node src/cli.ts check-config --config <config.jsonc>`。
2. 在 Admin Panel 保存或点 **Apply config file**；下一次 Bucket 到期就使用新参数。
3. 发送普通群消息，观察日志：
   - `agent_proactive_reply_sampled`：包含 `probability`、`attempt`、`consecutive_misses_before/after`、`hit` 与 `hard_pity`。
   - `agent_proactive_reply_bypassed`：直接唤起，包含 `trigger_kind`。
4. 未命中时在 Tool sessions / Messages 中会看到 Bucket 结束于 `proactive_reply_skipped`，且没有新 Invocation。
5. 连续发送普通消息，确认计数递增，并在到达 `hard_pity` 时出现 Invocation。

相关页面：[设置活跃时段与触发条件](participation.md)、[Telegram 配置](../configure/telegram.md)、[字段参考](../reference/fields.md)。
