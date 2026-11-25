---
title: Sticker 与贴纸集
description: 在管理面板添加与管理 Bot 允许发送的 Telegram 贴纸集，查看 Vision 视觉索引状态，以及了解模型如何搜索和发送贴纸。
---

# Sticker 与贴纸集

Bot 只会发送你允许的贴纸集里的贴纸。它们写进 `telegram.sticker_sets`，在 **Telegram → 贴纸集（Bot sticker sets）** 页管理，改动立即生效，无需重启。

![贴纸集页：已配置的贴纸集与贴纸搜索索引](__DOCS_BASE__/screenshots/images/sticker-sets.zh-CN.light.png)

## 添加、编辑与删除

1. 点「添加贴纸集」，填 **Telegram 贴纸集**：贴纸集名称（字母、数字、下划线），或直接粘贴 `https://t.me/addstickers/…` 分享链接。
2. 填**昵称**：以字母开头，可用字母、数字、`_` 与 `-`，最长 64 字符。
3. 可选填**备注**（最长 500 字符）：写给模型看的使用说明，例如「调侃朋友时使用；严肃话题中避免」。模型挑贴纸时会看到每个贴纸集的昵称与备注。
4. 保存后 Bot 会在后台从 Telegram 下载这些贴纸并逐张建立视觉索引，页面显示同步与索引进度。**索引需要已配置 Vision 模型**（见[看图与图片理解](vision.md)和[Vision 配置](../configuration/vision.md)）。

几条容易踩到的规则：

- **指向的 Telegram 贴纸集添加后不可更改**：要换成别的贴纸集，删除后重新添加。
- 编辑只能改昵称与备注。改名或改备注不会中止正在进行的回复，新内容在下一批消息时生效。
- 添加或删除贴纸集会中止正在进行的回复，让下一次回复直接看到新的贴纸列表。
- 删除只是让 Bot 不再使用它们，**索引会保留**，之后重新添加同一贴纸集时无需重新分析。

## 索引状态

页面下方是「贴纸搜索索引」，可以按贴纸集、索引状态（待处理 / 失败 / 已索引）筛选，并搜索描述或 emoji。每个贴纸占一行，列出描述、所用模型、分析版本，以及失败次数、下次重试和更新时间。失败会按退避重试（最长 6 小时），所以「失败 1 次」通常是临时的。

没有配置 Vision 模型时，视觉索引会自动暂停，已导入的贴纸保持待处理状态，不会持续累积失败次数。

## 模型怎么选贴纸

模型能看到每个贴纸集的昵称、备注，以及每张贴纸对应的 emoji。emoji 只是粗略提示，要真正发某张贴纸，模型会先用 `search_stickers` 查看候选（也可以按语义搜索），再用 `send` 发出，所以运行记录里发贴纸之前通常有一次 `search_stickers`。查到的贴纸过一段时间要重新查才能发。

如果群里有人单独发了一张贴纸，是否因此触发 Bot 参与由 `telegram.sticker_trigger_enabled` 控制，见 [Telegram 配置](../configuration/telegram.md)。

相关页面：[看图与图片理解](vision.md)、[图片生成](image-generation.md)、[Vision 配置](../configuration/vision.md)、[Telegram 配置](../configuration/telegram.md)
