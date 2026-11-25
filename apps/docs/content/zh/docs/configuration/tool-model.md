---
title: Tool Model 配置
description: 系统级辅助模型用在哪、怎么从全局 Agent 继承、为什么它不跟随每群覆盖，以及一个可直接使用的配置示例。
---

# Tool Model 配置

`tool_model` 是**系统级**辅助模型，它不参与聊天，只跑后台的、跨群共享的小任务。字段见 [`tool_model` 段字段参考](fields-tool-model.md)。

## 谁在用它

| 用途 | 说明 |
| --- | --- |
| 辞典融合 | 把多个候选词条融合成一条建议；结果只是建议，仍要人工确认后才保存。 |
| 群聊记忆整理 | 把安静的群聊消息整理成带 message-id 区间的事件摘要。 |
| MCP 描述起草 | 为渐进式 MCP Server 起草给模型看的描述草稿，再由人确认。 |
| 生图素材 AI 提取 | 从一张参考图里提取素材名与关键词。 |

前三项只要求 `text` 输入，素材提取需要模型同时支持 `image` 与 `text`，所以继承来的纯文本模型可能不够用。面板可以在那一次提取时临时指定另一个具备图片输入能力的模型，不影响 `tool_model` 的配置。

## 继承规则

整个段可以省略。省略时 `tool_model` **继承全局 Agent** 的 `provider`、`model` 与 `thinking_level`，三个一起继承，不逐项混合。

它刻意不跟随每群覆盖。一个群把自己的对话模型换成别的，不会改变系统级辅助调用，否则某个群的设置会悄悄改变全实例的辞典融合或群聊记忆整理结果。继承只读全局 `agent` 段。

如果全局 Agent 的三元组也不完整、而 `tool_model` 又没配，就没有可用的辅助模型，需要它的功能会明确报「未配置」，不会退化成某个随机模型。

## 配置

三个字段都必须写出，取值规则与 Agent 相同：

```jsonc
{
  "tool_model": { "provider": "gateway", "model": "replace-with-your-text-and-image-model", "thinking_level": "off" }
}
```

- `provider` + `model` 必须指向 `providers` 里已注册的模型，并且支持 `text` 输入。
- `thinking_level` 必须是该模型接受的级别，非推理模型只能写 `off`。
- 校验在 `check-config` 与每次配置应用时都会跑，不合法的组合直接被拒绝，不会等到第一次辅助调用才失败。

## 生效与恢复继承

`tool_model` 是热字段，下一次辅助调用使用新选择，运行中的调用继续用它开始时取到的模型。想恢复继承，删除整个 `tool_model` 段并应用，在面板「模型」页的 Tool Model 卡片上选择恢复继承也是删掉这一段。

在面板里选择模型与思考强度的操作见[接入和更换模型](../guides/models.md)。
