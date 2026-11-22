---
title: Provider 与模型定义
description: builtin 与 custom 两种 Provider、API 兼容层、模型元数据、昵称、compat、工具 Schema 收敛、thinking 级别与成本。
---

# Provider 与模型定义

`providers` 段是「哪些模型可用」的唯一事实源：Provider 目录里存在、但配置里没写的模型，运行时一律不可用。管理面板「供应商」页维护的就是这一段，本页是它的文件形式与校验规则；字段逐项见 [`providers` 段字段参考](fields-providers.md)。

## Provider 的两种形态

每个键是一个 alias，必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`（它出现在面板 API 路径与重载报告里）。alias 是配置内部的名字，与真实供应商无关：

- `kind: "builtin"`：复用 Pi 自带的供应商目录，写入 Pi 的 `provider` id；`base_url` 与 `api` 由目录提供，不能写。
- `kind: "custom"`：自己声明 `base_url` 与 `api` 兼容层。

两者都必须写 `api_key`（SecretRef）；custom 还可以写 `headers`（每个值同样是 SecretRef）。

### builtin

builtin 必须满足：Pi 目录里有这个 id、目录里至少有一个模型使用受支持的四种 API 之一、`baseUrl` 是具体地址（不含 `{account}` 占位）、认证方式支持 API key。不满足的 id（例如只支持 OAuth 的供应商，或写死的占位地址）会被 `check-config` 拒绝——这类供应商没法只靠一把配置好的 key 驱动。

每个配置模型用 Pi 目录里它自己条目的 API 派发；目录里没有的 id 在单一 API 目录上沿用该目录的 API，在混合目录上按 OpenAI 兼容处理。所以同一个 builtin Provider 下可以混放不同 API 的模型。

`kind: "builtin"` 的典型写法：

```jsonc
{
  "providers": {
    "google": {
      "kind": "builtin",
      "provider": "google",
      "api_key": { "env": "GOOGLE_API_KEY" },
      "models": [
        {
          "id": "gemini-3.7-flash",
          "name": "Gemini 3.7 Flash",
          "nickname": "常用聊天模型",
          "reasoning": true,
          "thinking_levels": ["low", "medium", "high"],
          "input": ["text", "image"],
          "context_window": 1048576,
          "max_tokens": 65536,
          "cost": { "input": 0.3, "output": 2.5, "cache_read": 0.075, "cache_write": 0.3 }
        }
      ]
    }
  }
}
```

（模型 id 与价格只是示意，替换成自己账号下真实可用的模型。）

### custom

custom 必须写 `base_url` 与 `api`。`api` 只能是四种之一：

| `api` | 适用 |
| --- | --- |
| `openai-responses` | OpenAI Responses 协议，以及兼容它的网关。 |
| `openai-completions` | OpenAI Chat Completions 协议（最常见的一类兼容层）。 |
| `anthropic-messages` | Anthropic Messages 协议。 |
| `google-generative-ai` | Google Generative AI 协议；`base_url` 必须已经带版本路径（例如 `…/v1beta`），运行时不会再补版本号。 |

`base_url` 会被去掉末尾的 `/`；它必须是 HTTP(S)、不带凭据、查询与片段。

```jsonc
{
  "providers": {
    "gateway": {
      "kind": "custom",
      "base_url": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "api_key": { "env": "GATEWAY_API_KEY" },
      "headers": { "X-Tenant": { "env": "GATEWAY_TENANT" } },
      "models": [
        {
          "id": "replace-with-your-text-and-image-model",
          "name": "Replace with an available model",
          "reasoning": true,
          "compat": { "thinking_format": "openrouter", "max_tokens_field": "max_tokens" },
          "tool_schema_keywords": "minimal",
          "input": ["text", "image"],
          "context_window": 128000,
          "max_tokens": 8192,
          "cost": { "input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1 }
        }
      ]
    }
  }
}
```

## 模型条目

`models` 是显式启用列表，每个条目必填 `id`、`reasoning`、`input`、`context_window`、`max_tokens` 与完整的 `cost`；`name`、`nickname`、`thinking_levels`、`compat`、`tool_schema_keywords` 可选。

- **`id`**：发给供应商的模型 id，在同一个 Provider 内唯一。
- **`name`**：模型的上游展示名。面板会显示它；`/model` 列表在模型没有昵称时会把它附在 `provider / model` 后面，定位与校验始终用 `id`。
- **`reasoning`**：模型能否思考。`false` 的模型不能声明 `thinking_levels`，`check-config` 会拒绝。
- **`thinking_levels`**：该模型接受的思考级别，取值 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，从弱到强；至少一项、不能重复。省略则沿用 Pi 的默认档位（`off` 到 `high`）。
- **`input`**：至少一项，`text` 或 `image`。Agent 模型必须支持 `text`，Vision 模型必须支持 `image`。
- **`context_window` / `max_tokens`**：上下文窗口与单次输出上限，`max_tokens` 不能大于 `context_window`。
- **`cost`**：输入、输出、缓存读、缓存写四项，单位是**每百万 Token 的美元价**。它不参与预算判断（预算是按 Token 计的熔断），只用于计算并记录每次模型调用的费用。

## 昵称

`nickname`（1–64 字符）只影响 Telegram 命令里的展示：设置后 `/status`、`/model`、`/effort` 用昵称代替 `provider / model`，`/model` 列表行只显示「序号. 昵称」，不暴露 Provider 与模型 id。昵称不要求唯一，也不影响定位、切换与校验——那些始终用真实的 `provider` / `model`。管理面板照旧显示真实名称。

## compat：把自动探测钉死

`compat` 是 Pi 对各家方言的检测覆盖。**能省略就省略**：省略即「自动」，由 Pi 按 provider id 与 base URL 检测，升级 Pi 后检测改进会自动生效；写死一个值等于冻结它。

| 字段 | 取值 | 适用 API |
| --- | --- | --- |
| `supports_developer_role` | `true` / `false` | `openai-completions`、`openai-responses` |
| `thinking_format` | `openai`、`openrouter`、`deepseek`、`together`、`zai`、`qwen`、`string-thinking` | `openai-completions` |
| `max_tokens_field` | `max_completion_tokens` / `max_tokens` | `openai-completions` |
| `requires_reasoning_content` | `true` / `false` | `openai-completions` |
| `cache_control_format` | `anthropic` | `openai-completions` |

模型的 API 不适用某个字段时，写入会被拒绝：`anthropic-messages` 与 `google-generative-ai` 一个都不接受。

## tool_schema_keywords：给文法折叠端点收敛

有些端点会把 Tool 参数折叠成解码文法，遇到不认识的 JSON Schema 关键字就整条请求 400，模型一个 Token 都没生成。`tool_schema_keywords: "minimal"` 让运行时把发给这个模型的 Tool 定义收敛成「能折叠」的形状：丢弃只用于事后校验的注解（`minLength`、`pattern`、`minimum`、`maxItems`、`uniqueItems`、`default`、`format` 等），把 `anyOf`/`oneOf` 收敛成第一个带 `type` 的变体。

省略即原样发送。收敛只改发给模型的那份副本，每个 Tool 仍在自己的边界重新校验参数，所以它不会放松任何限制。

## 引用与生效

`agent.provider`/`agent.model`、`vision.*`、`tool_model` 与每个 Chat 的覆盖都按 alias + 模型 id 查这里，引用不存在的 alias 或模型会被拒绝。删掉仍被引用的模型同样会被拒绝。

Provider 的每个字段都是热字段：应用后按新定义重建模型注册表；只改模型列表时沿用已有连接，连接字段（`base_url`、`api`、`api_key`、`headers`、builtin 的 `provider`）变化会重新解析 SecretRef。运行中的 Invocation 继续用它启动时的快照，下一次 Invocation 才用新值。详见[配置生命周期](lifecycle.md)。

在面板里添加 Provider、拉取模型列表与健康检查的操作见[接入和更换模型](../guides/models.md)。
