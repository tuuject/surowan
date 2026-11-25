---
title: 看图与图片理解
description: 分清主模型直接看图、Vision 模型按需看图与图片生成三条链路，了解引用授权隔离、预算边界与原图发送规则。
---

# 看图与图片理解

图片相关的行为分成三条互不相同的链路，先分清它们，后面的设置才不会配错地方：

| 链路 | 用到的模型 | 在哪里配置 |
| --- | --- | --- |
| 直接看图：新消息里的图片附带给主模型 | **Agent** 模型（必须支持图片输入） | [Agent 配置](../configuration/agent.md) 的 `providers` 模型能力 |
| 按需看图：更早的图片、Sticker 由 `read_image` 分析成文字描述 | **Vision** 模型（可与主模型不同） | [Vision 配置](../configuration/vision.md) |
| 画图与改图 | OpenRouter 上的生图模型 | [图片生成](image-generation.md) 或 `image` 段 |

如果已经分清链路、准备配置贴纸或开启画图，可以直接看[Sticker 与贴纸集](stickers.md)和[图片生成](image-generation.md)。

## 直接看图与 Vision 的分工

这两件事经常被混为一谈：

- **主模型支持图片输入**时，最新一个批次里收到的照片与受支持的图片文件会直接附带给主模型。这些图片只附带这一次，不会留在之后的上下文里。
- **更早的图片**和所有 Sticker，都要模型主动调用 `read_image`，由 **Vision** 模型分析并返回文字描述。
- 没有配置 Vision 时，`read_image` 不可用，历史图片和 Sticker 都看不到，Sticker 的视觉索引也会暂停（已导入的贴纸保持待处理，不累积失败）。
- Vision 有独立的模型、思考强度、并发与每日预算（`max_tokens` 与 `max_images`），见[Vision 配置](../configuration/vision.md)与 [`vision` 字段参考](../configuration/fields-vision.md)。

## 模型能看到哪些图片

模型只能看当前对话里出现过、而且还没过期的图片与贴纸。不同会话之间、同一个群的不同话题之间互相看不到，模型也不能凭文件 ID 或会话 ID 去读别处的图片。

在网页读取里遇到的图片也遵守同样的隔离与过期规则（单张上限 20 MiB，支持 JPEG / PNG / WebP），见[网络搜索与网页读取](web-search.md#网页读取与看图)。

## 要原图或以文件发送

图片按照片发送时会被 Telegram 压缩。只有用户明确说要「原图」或「以文件发送」，模型才会改用 `send` 的 `kind: file`：

- 会话里的普通图片：发送 Telegram 保存的那份。普通照片上传时已被 Telegram 压缩，发成文件也找不回更高画质，以文件形式收到的图片则原样转发。
- Bot 生成的图片：发送生图服务产出的原始文件（详见[图片生成](image-generation.md#要原图或要文件)）。直接回复那张图说「发原图」，发出的是那次交付的全部原图。
- 贴纸不支持，会说明原因。
- 原图文件已清理时，会说明拿不到，不会拿压缩版冒充。
- Playground 房间没有文件消息，不支持这种发送。

## 费用与预算边界

- 直接附带给主模型的图片按主模型用量计入全局每日预算（`agent.daily_budget.max_tokens`）。
- 聊天内触发的 `read_image` 消耗同样受每日预算约束，后台 Vision 视觉分析（如贴纸索引）另有自己独立的每日预算（`vision.daily_budget`）。

相关页面：[Sticker 与贴纸集](stickers.md)、[图片生成](image-generation.md)、[Vision 配置](../configuration/vision.md)、[接入和更换模型](models.md)
