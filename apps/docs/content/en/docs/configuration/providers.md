---
title: Providers and models
description: Built-in and custom providers, API kinds, model metadata, nicknames, compat overrides, tool schema reduction, thinking levels and cost.
---

# Providers and models

The `providers` section is the single source of truth for which models exist: a model that Pi's catalog knows but this file does not list is simply unavailable at runtime. The panel's Providers page maintains this section; this page covers its file form and validation rules. Field by field see the [`providers` field reference](fields-providers.md).

## Two kinds of provider

Each key is an alias matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (it appears in API paths and reload reports). The alias is internal and unrelated to the real vendor:

- `kind: "builtin"` reuses Pi's provider catalog and names the Pi `provider` id; `base_url` and `api` come from the catalog and must not be written.
- `kind: "custom"` declares its own `base_url` and `api` compatibility layer.

Both require `api_key` (a SecretRef); a custom provider may also declare `headers`, each value again a SecretRef.

### Built-in

A built-in provider must satisfy: the id exists in Pi's catalog, at least one catalog model speaks one of the four supported APIs, the catalog `baseUrl` is concrete (no `{account}` placeholder) and the catalog authenticates with an API key. Anything else — OAuth-only providers or placeholder URLs — is rejected by `check-config`, because a single configured key cannot drive it.

Each configured model is dispatched with the API of its own catalog entry. An id the catalog does not list inherits the catalog's API when the provider has exactly one, and falls back to the OpenAI-compatible protocol on a mixed catalog. One built-in provider can therefore hold models of different APIs.

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
          "nickname": "Everyday chat",
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

(Model ids and prices are illustrations; replace them with models your account can actually use.)

### Custom

A custom provider must write `base_url` and `api`. `api` is one of four:

| `api` | Used for |
| --- | --- |
| `openai-responses` | The OpenAI Responses protocol and gateways that speak it. |
| `openai-completions` | The OpenAI Chat Completions protocol, the most common compatibility layer. |
| `anthropic-messages` | The Anthropic Messages protocol. |
| `google-generative-ai` | The Google Generative AI protocol; `base_url` must already contain the version path (for example `…/v1beta`), the runtime does not append one. |

Trailing `/` characters are stripped from `base_url`. It must be HTTP(S) with no credentials, query or fragment.

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

## Model entries

`models` is the explicit enable list. Each entry requires `id`, `reasoning`, `input`, `context_window`, `max_tokens` and a complete `cost`; `name`, `nickname`, `thinking_levels`, `compat` and `tool_schema_keywords` are optional.

- **`id`**: the model id sent to the provider, unique within that provider.
- **`name`**: the upstream display name. The panel shows it, and the `/model` list appends it to `provider / model` when the model has no nickname; identity and validation always use `id`.
- **`reasoning`**: whether the model can think. A `false` model may not declare `thinking_levels`; `check-config` rejects that.
- **`thinking_levels`**: the levels this model accepts, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (weakest to strongest); at least one, no duplicates. Omitting the list keeps Pi's default range (`off` through `high`).
- **`input`**: at least one of `text` and `image`. An agent model must accept `text`, a vision model must accept `image`.
- **`context_window` / `max_tokens`**: the context window and the per-call output ceiling; `max_tokens` may not exceed `context_window`.
- **`cost`**: input, output, cache read and cache write, in **US dollars per million tokens**. It does not feed budget enforcement (that is a token circuit breaker); it is used to compute and record the cost of every model call.

## Nickname

`nickname` (1–64 characters) only changes what Telegram commands show. With one set, `/status`, `/model` and `/effort` print the nickname instead of `provider / model`, and a `/model` list line becomes `3. nickname` without exposing the provider or model id. Nicknames need not be unique and never affect identity, switching or validation — those always use the real `provider` / `model`. The Admin Panel keeps showing real names.

## compat: freezing Pi's detection

`compat` overrides how Pi detects each vendor's dialect. **Omit it whenever possible**: an omitted field means "automatic", so improving detection in a future Pi release reaches you; writing a value freezes it.

| Field | Values | Applies to |
| --- | --- | --- |
| `supports_developer_role` | `true` / `false` | `openai-completions`, `openai-responses` |
| `thinking_format` | `openai`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, `string-thinking` | `openai-completions` |
| `max_tokens_field` | `max_completion_tokens` / `max_tokens` | `openai-completions` |
| `requires_reasoning_content` | `true` / `false` | `openai-completions` |
| `cache_control_format` | `anthropic` | `openai-completions` |

A field the model's API does not support is rejected: `anthropic-messages` and `google-generative-ai` accept none of them.

## tool_schema_keywords: reducing tool schemas

Some endpoints fold tool parameter schemas into a decoding grammar and reject the whole request with a 400 when they meet a keyword they do not know — before the model has produced a single token. `tool_schema_keywords: "minimal"` makes the runtime reduce this model's tool definitions to a foldable shape: annotation-only keywords (`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `maxItems`, `uniqueItems`, `default`, `format`, …) are dropped, and `anyOf`/`oneOf` collapse to the first variant that carries a `type`.

Omitting it sends every keyword the runtime builds. The reduction only changes the copy sent to the model: each tool validates its arguments again at its own boundary, so nothing is relaxed.

## References and effect

`agent.provider`/`agent.model`, `vision.*`, `tool_model` and every per-Chat override resolve here by alias plus model id; an unknown alias or model is rejected, and so is deleting a model that is still referenced.

Every provider field is hot: an apply rebuilds the model registry from the new definition. A model-list-only change keeps the existing connection; a change to the connection fields (`base_url`, `api`, `api_key`, `headers`, a built-in's `provider`) re-resolves its SecretRef. Running invocations keep the snapshot they started with and the next invocation uses the new values. See [configuration lifecycle](lifecycle.md).

Adding providers, fetching model lists and running health checks from the panel are covered in [connect and switch models](../guides/models.md).
