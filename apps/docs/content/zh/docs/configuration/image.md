---
title: 图片生成配置
description: image 段的凭据、模型目录与能力声明，域校验失败时的禁用降级，以及整体热更新行为。
---

# 图片生成配置

`image` 段定义生图模型目录，以及这些模型使用的上游凭据。没有这一段，图片生成就是关闭的：模型看不到 `image_generate`、`list_image_models`、`search_image_assets`，面板也提交不了生成。

生图走内置的 OpenRouter adapter 直连上游，不经过 `providers` 里的聊天模型连接。`credentials` 里的密钥就是上游服务（如 OpenRouter）的密钥，和聊天模型的密钥互不相干。

## 什么时候可用

一段配置要真正变成「可用」，需要同时满足：

1. `image` 段存在，并且通过 Schema 的结构校验；
2. 每个 `credentials` 里的 SecretRef 都能解析出非空值；
3. 每个模型都通过 image-service 的领域校验（下列枚举、唯一性、凭据引用都存在）。

三条都满足后：Telegram 会话直接可用；虚拟群聊里该房间还要管理员打开「图片生成」开关（默认关闭，真实计费），因为同一进程可能同时服务两种宿主。

## 生效方式

`image` 段整体是热更新，启用、禁用、换模型、换凭据都不需要重启：

- 每次应用配置都会重新解析凭据、重新校验模型，然后**原子替换**整份图片快照；不会有半新半旧的状态被读到。
- 快照的版本号覆盖模型与**已解析的凭据值**，所以即使在 keychain 里原地轮换密钥、配置文件一字未改，下一次应用也会发布新快照。
- 运行中的 Invocation 保留它开始时那一套能力；下一次 Invocation 用新快照。

## 字段

| 字段 | 说明 |
| --- | --- |
| `credentials` | 必需。条目名 → SecretRef 的映射。条目名只能是小写/大写字母、数字、下划线、短横线，1–80 字符。 |
| `models` | 必需，最多 64 项。每一项是一种可选模型。 |
| `models[].id` | 模型标识，1–80 个字母、数字、下划线或短横线；同一个段内不能重复。模型把 `image_generate.model_id` 设为它来选型。 |
| `models[].name` | 面板与 `list_image_models` 显示的名称，1–80 字符。 |
| `models[].description` | 可选，最长 1000 字符。写给模型看的选型与提示词偏好备注。 |
| `models[].provider` | 生图 adapter 类型。当前只接受 `openrouter`。 |
| `models[].upstreamModel` | 上游真实模型 ID，形如 `openai/gpt-image-1`。 |
| `models[].credentialRef` | 必须命中 `credentials` 里的一个条目名；该条目就是这次生成用的密钥。 |
| `models[].providerTag` | 上游路由过滤标签，`tag` 或 `tag/subtag` 形式。 |
| `models[].capabilities.imageInput` | 是否接受参考图。`false` 时 `maxInputImages` 必须是 `0`。 |
| `models[].capabilities.maxInputImages` | 每次生成的参考图上限，0–16。 |
| `models[].capabilities.maxOutputs` | 每次生成的输出张数上限，1–10。模型调用 `image_generate` 时一次最多要 4 张。 |
| `models[].capabilities.aspectRatios` | 允许的比例，非空，取值来自 `auto`、`1:1`、`2:3`、`3:2`、`4:3`、`3:4`、`16:9`、`9:16`。 |
| `models[].capabilities.resolutionClasses` | 允许的清晰度档位，非空，取值来自 `auto`、`low`、`medium`、`high`。 |

`description` 只进入模型可见的模型目录（`list_image_models` 的结果），系统不会把它拼进发给上游的提示词，也不会作为单独字段发送。别在这里写密钥。

### 两层校验与禁用降级

`image` 段是整份配置里唯一被**软校验**的段：

- **结构不合法**（缺字段、类型不对、枚举外取值、条目名不合规）：加载时**剔除整段并记一条警告**，进程照常启动，只是图片生成关闭。警告文本是 `image generation disabled: the "image" section is invalid and was ignored (...)`，在 `config_warnings` 日志里能看到。改好或删掉这段就会恢复。
- **结构合法但领域不合法**（重复的模型 ID、`credentialRef` 指向不存在的条目、`imageInput: false` 却声明了参考图上限、比例或清晰度不在枚举内、`provider` 不是 `openrouter`）：
  - 启动时：记 `image_service_warning` 日志，图片生成保持关闭，Bot 照常运行；
  - 面板应用配置时：整个应用失败（`config_invalid` 或 `secret_unresolved`），旧配置与旧快照继续生效。

换句话说：`image` 段写坏了永远不会让服务起不来。

## 一个最小例子

```jsonc
{
  "image": {
    "credentials": {
      "openrouter": { "env": "OPENROUTER_API_KEY" }
    },
    "models": [
      {
        "id": "gpt-image-1",
        "name": "GPT Image",
        "description": "日常插画优先；用自然语言写主体、构图和光线",
        "provider": "openrouter",
        "upstreamModel": "openai/gpt-image-1",
        "credentialRef": "openrouter",
        "providerTag": "openai",
        "capabilities": {
          "imageInput": true,
          "maxInputImages": 4,
          "maxOutputs": 4,
          "aspectRatios": ["auto", "1:1", "3:4", "4:3", "16:9", "9:16"],
          "resolutionClasses": ["auto", "low", "medium", "high"]
        }
      }
    ]
  }
}
```

只配一个模型时，模型提交生成可以省略 `model_id`；配了多个就必须自己选。

## 与其他段的关系

- 密钥引用写法、`key.json` 与轮换：见[密钥与路径](secrets.md)。
- 想少花生图的钱、或让模型别乱画：见[看图、Sticker 与图片生成](../guides/images.md)。
- `image` 不是 `vision`：`vision` 负责「看懂图」，`image` 负责「画图」。两者可以只配一个。
- 配置面板里对应的页面是「图片设置」；工作台、记录与素材分别是「图片生成」「生图记录」「生图素材」。

字段类型、取值范围与必填性见[图片字段参考](fields-image.md)。
