---
title: 设置活跃时段与触发条件
description: 让群聊只在指定时段或被 @、回复、关键词触发后参与。
---

# 设置活跃时段与触发条件

默认情况下，allowlist 中的群聊遇到可触发消息就会开一个消息 Bucket。`participation` 适合希望 Bot 在群里保持安静、但在工作时间或被明确叫到时回应的场景。

参与闸门只决定消息能否触发运行，**不决定模型是否发送消息**。进入活跃时段、@ 或命中关键词都不保证必回；表达和参与倾向仍由人格与模型决定。

## 配置全局默认

下面是局部 JSONC 片段（不是完整配置）：

```jsonc
{
  "telegram": {
    "participation": {
      "active_windows": [
        { "start": "09:00", "end": "12:00" },
        { "start": "20:00", "end": "01:00", "days": [5, 6, 7] }
      ],
      "trigger_keywords": ["塑料碗", "wan"],
      "attention_window_seconds": 300
    }
  }
}
```

时段按 Chat 时区解释（Chat 未设置时使用顶层 `timezone`）。`days` 使用 ISO 星期 1–7；结束时间早于开始时间表示跨午夜，`24:00` 表示当天结束。关键词匹配消息文本和 caption，忽略大小写。带标题、列表、表格或图片的富文本消息（Rich Message，常见于其他 Bot 的回复或其转发）匹配其中看得见的文字，链接地址和文件名不算；富文本里 @ 到 Bot 同样算直接 @。

## 为单个群覆盖

将同名字段放入 `telegram.chats[]` 的 Chat 项（仍是局部片段），或在 Admin Panel 的 **Chats** 页用每行的时钟按钮编辑活跃时段（面板支持多个时间段与按星期生效，保存后立即应用）：

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "participation": {
          "active_windows": [],
          "trigger_keywords": ["值班"],
          "attention_window_seconds": 600
        }
      }
    ]
  }
}
```

Chat 的 `active_windows` 存在时整体替换全局时段；空数组表示没有活跃时段。关键词则是在全局列表上追加；Chat 写 `[]` 表示不增加关键词。注意力窗口按 Chat + Forum Topic 单独计时。

## 仅 /ask 唤起

在全局 `telegram.participation` 或单群 `telegram.chats[].participation` 中设置 `"ask_only": true`，也可在面板 Chats 的活跃时段对话框选择「仅 /ask 唤起」。默认关闭；单群值覆盖全局，显式 `false` 可退出全局开启的模式。该字段热应用，私聊不受限制。

开启后，普通消息、@、回复 Bot、关键词、Sticker 和其他 Bot 消息都不会触发或加入 Bucket；消息仍照常保存，下次唤起时作为历史可见，群聊记忆也照常整理。此时活跃时段、关键词和注意力窗口均不生效，不必删除原配置。

成员发送 `/ask 问题内容`（也支持 `/ASK`、`/ask@本Bot用户名`），在一条消息里写完问题。它会创建 0 秒 Bucket，只收这条 `/ask`，不顺带其他 Bot 消息、不留下注意力窗口；若前一批仍在收集，新 `/ask` 可以合入。暂停、休眠等闸门仍有效，模型仍自行决定是否发言。

未开启 ask-only 时，`/ask` 像直接 @ 一样使用正常聚合窗口，时段外打开或刷新注意力窗口，并绕过主动回复概率抽样。正文（含前缀）原样进入聊天记录和模型上下文；编辑不触发。匿名管理员和频道身份可用，其他 Bot 不可用；只识别正文开头的 Telegram 命令，不识别 caption。

使用过 `/ignoreme` 的成员仍可发送 `/ask`：这一条会保存并触发，其余普通消息、@ 和回复继续被丢弃。继续对话也需再次 `/ask`，或先 `/unignoreme` 恢复接收。

## 触发规则

活跃时段外，只有以下消息能打开或刷新窗口：`/ask`、直接 @ Bot、回复 Bot 自己发过的消息、命中关键词。命中后，窗口内的后续可触发消息按活跃时段处理。活跃时段内不需要关键词，行为与未配置 participation 相同。

被闸门拦下的消息仍会保存，并可能在下一次触发时作为历史提供给模型；编辑消息不会触发或刷新窗口。私聊不受 participation 影响，暂停期间也不会创建窗口。

## 让修改生效和验证

1. 运行 `node src/cli.ts check-config --config <config.jsonc>`。
2. 通过 Admin Panel 保存或「Apply config file」应用修改——participation 属于热更新白名单，立即生效；时段按该 Chat 的 `timezone`（缺省全局时区）计算。
3. 在群外时段发送普通消息，确认没有新 Invocation；随后 @ Bot、回复 Bot 或发送关键词，确认产生 Bucket。
4. 在 Admin Panel 的 Tool sessions / Messages 查看 Invocation 和消息；命中时日志包含 `agent_attention_triggered` 及 `trigger_kind`。

## 常见误区

- allowlist 和 participation 是两道不同的门：群不在 allowlist 中时，触发词也不能让 Bot 处理。
- Forum Topic 共享 Chat 的时段，但注意力窗口只作用于命中的那个 Topic。
- 时段结束会立即回到静默；时段末尾的 @ 不会自动延长到时段外。
- 单独 Sticker 默认不会开 Bucket，除非另外启用 `sticker_trigger_enabled`。

相关页面：[控制主动插话频率](proactive-replies.md)、[Telegram 配置](../configure/telegram.md)、[排障](../operations/troubleshooting.md)、[字段参考](../reference/fields.md)。
