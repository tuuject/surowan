---
title: Vision 配置
description: 图片与 Sticker 分析所用的模型对、thinking_level 缺省规则、独立并发与预算、未配置时的降级，以及已废弃的旧并发字段。
---

# Vision 配置

`vision` 决定「谁来细看图片」：`read_image` 的按需分析与 Sticker 的后台视觉索引都走它。它和主 Agent 是分开的两件事——多模态主模型可以直接看到新消息里的图片，不需要 Vision；需要独立模型按需看图时，才配置这一段。

`vision` 是可选的，整段省略、写 `null` 或写不完整的对象都合法。字段见 [`vision` 段字段参考](fields-vision.md)。

## 模型对

`provider` 与 `model` 必须同时写出才会启用：只写一个时 `check-config` 只给警告，运行时视为「没有视觉模型」。两者齐全时，模型必须存在于 `providers` 里、支持 `image` 输入，并且 `vision.max_output_tokens` 不能超过该模型声明的 `max_tokens`。

最小启用示例（模型来自你自己的 Provider）：

```jsonc
{
  "vision": { "provider": "gateway", "model": "replace-with-your-text-and-image-model" }
}
```

其余字段都有默认值，省略即可。

## thinking_level

`vision.thinking_level` 可选。不写时由所选模型推导：

- 模型接受 `low` 就用 `low`；
- 否则用它接受的最弱非 `off` 级别；
- 不推理的模型只有 `off`，不会发送任何思考参数。

写了就按普通规则校验：必须是该模型接受的级别，否则 `check-config` 报错。它和 `provider`/`model` 一样是热字段，但在面板里只换模型时，运行时会把新模型不接受的已存级别删掉，回到上面的默认规则。

## 并发、缓存与预算

| 字段 | 运行时默认 | 作用 |
| --- | --- | --- |
| `max_output_tokens` | `2048` | 每次视觉分析的输出上限；不能超过模型上限。 |
| `max_concurrency` | `2` | 前台 `read_image` 的并发上限。 |
| `prompt_version` | `1` | 参与视觉缓存的身份（`<provider>/<model>/prompt-<version>`）；改变描述规则时递增。 |
| `daily_budget.max_tokens` | `200000` | 后台 Sticker 索引的每日 Token 上限。 |
| `daily_budget.max_images` | `200` | 后台 Sticker 索引的每日图片数上限。 |

两个要点容易被误解：

- **`daily_budget` 只作用于后台 Sticker 索引**（计量记在 `system`/`sticker_index`）。聊天里触发的 `read_image` 计入全局 `agent.daily_budget.max_tokens`，不是这一份。
- **`max_concurrency` 与 `prompt_version` 是重启字段**，它们在服务构造时读取；`provider`、`model`、`thinking_level`、`max_output_tokens` 是热字段，下一次分析就用新值。

## 未配置时会怎样

没有可用的模型对时，功能不是「失败」，而是按缺省降级：

- `read_image` 拒绝调用（错误码 `vision_unconfigured`），不写分析记录。
- Sticker 后台索引暂停，行保持 `pending`，不累计失败与退避。
- 多模态主模型仍会直接收到新注入的图片；只有「按需细看」与「Sticker 理解」不可用。
- 稳定系统提示里的图片说明改成「无法检查图片」的版本，`{{ vision.* }}` 模板变量渲染为空串。
- `doctor` 跳过视觉探针，输出里给 `vision: null`。

补齐模型对并应用后，以上能力立刻恢复，不需要重启。

## 已废弃字段

`vision.background_sticker_concurrency` 只为升级兼容保留：Schema 仍接受（过去只能填 `1`），运行时完全不读，请直接删除。它没有替代字段——后台索引的并发由内部实现决定，不再暴露为配置。出现时会有一条加载警告，面板「警告」页也会列出，见[配置生命周期](lifecycle.md)。

## 生效方式

`vision.provider`、`model`、`thinking_level`、`max_output_tokens` 热应用；`max_concurrency`、`prompt_version`、`daily_budget` 需要重启。换模型后，同一张图片会按新的缓存身份重新分析；已经索引过的 Sticker 不会重跑。
