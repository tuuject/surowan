---
title: Image generation settings
description: Credentials, model catalog and capabilities of the image section, the disable-on-invalid fallback, and how it applies without a restart.
---

# Image generation settings

The `image` section defines a catalog of image generation models and the upstream credentials they use. Without this section image generation is off: the model never sees `image_generate`, `list_image_models` or `search_image_assets`, and the panel cannot submit a generation.

Generation goes straight to the upstream service through the bundled OpenRouter adapter. It does not use a chat model connection from `providers`; the keys in `credentials` are upstream keys (OpenRouter, for example), separate from the chat model keys.

## When it becomes usable

All three of these must hold:

1. the `image` section exists and passes structural schema validation;
2. every SecretRef in `credentials` resolves to a non-empty value;
3. every model passes the image-service domain rules (the enumerations below, unique model ids, a credential entry that exists).

Once they do, Telegram chats can generate immediately. A Playground room still needs its administrator to turn on the room's **Image generation** switch (off by default, real billing), because one process can serve both hosts at once.

## How it takes effect

The whole section is hot — enabling, disabling, swapping models and rotating credentials all apply without a restart:

- Every apply resolves the credentials and validates the models again, then swaps the complete image snapshot atomically. No reader ever sees a half-updated configuration.
- The snapshot version covers the models and the **resolved credential values**, so rotating a keychain entry in place republishes a new snapshot even when the configuration file did not change by a byte.
- A running Invocation keeps the capability set it started with; the next Invocation uses the new snapshot.

## Fields

| Field | Meaning |
| --- | --- |
| `credentials` | Required. Entry name → SecretRef. Names use 1–80 letters, digits, underscores or hyphens. |
| `models` | Required, at most 64 entries. Each entry is one selectable model. |
| `models[].id` | Model identifier, 1–80 letters, digits, underscores or hyphens, unique within the section. The agent passes it as `image_generate.model_id`. |
| `models[].name` | Display name in the panel and in `list_image_models`, 1–80 characters. |
| `models[].description` | Optional, at most 1,000 characters. A selection and prompt-style note written for the agent. |
| `models[].provider` | Adapter kind. Today only `openrouter` is accepted. |
| `models[].upstreamModel` | The real upstream model id, such as `openai/gpt-image-1`. |
| `models[].credentialRef` | Must name an entry in `credentials`; that entry supplies the key for this model. |
| `models[].providerTag` | Upstream routing tag, `tag` or `tag/subtag`. |
| `models[].capabilities.imageInput` | Whether reference images are accepted. When `false`, `maxInputImages` must be `0`. |
| `models[].capabilities.maxInputImages` | Reference images per generation, 0–16. |
| `models[].capabilities.maxOutputs` | Images per generation, 1–10. One `image_generate` call asks for at most 4. |
| `models[].capabilities.aspectRatios` | Allowed ratios, non-empty, from `auto`, `1:1`, `2:3`, `3:2`, `4:3`, `3:4`, `16:9`, `9:16`. |
| `models[].capabilities.resolutionClasses` | Allowed quality classes, non-empty, from `auto`, `low`, `medium`, `high`. |

`description` only reaches the model-visible catalog (`list_image_models`). The runtime never concatenates it into the prompt sent upstream and never sends it as a separate field. Do not put keys in it.

### Two layers of validation

`image` is the only section that is **soft-validated**:

- **Structurally invalid** (missing fields, wrong types, values outside an enumeration, a bad entry name): the loader **strips the whole section and records a warning**. The process still starts, with image generation off. The warning reads `image generation disabled: the "image" section is invalid and was ignored (...)` and shows up in the `config_warnings` log line. Fix or delete the section to recover.
- **Structurally valid but domain-invalid** (duplicate model id, a `credentialRef` that names no entry, `imageInput: false` with a non-zero reference-image limit, a ratio or quality class outside the enumeration, a `provider` other than `openrouter`):
  - at startup: an `image_service_warning` log line, image generation stays off, the bot keeps running;
  - when applying a configuration from the panel: the whole apply fails (`config_invalid` or `secret_unresolved`) and the previous configuration and snapshot stay active.

A broken `image` section can never stop the service from starting.

## Minimal example

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
        "description": "Everyday illustration first; describe subject, composition and lighting in natural language",
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

With a single model the agent may omit `model_id`; with several it has to choose.

## Interactions

- Secret reference syntax, `key.json` and rotation: [Secrets and paths](secrets.md).
- Spending less on images, or keeping the agent from drawing at all: [Images, stickers and image generation](../guides/images.md).
- `image` is not `vision`: `vision` reads pictures, `image` draws them. Configuring only one is fine.
- The panel page is **Image settings**; the workbench, history and library are **Image generation**, **Image generations** and **Image assets**.

Types, ranges and required-ness: [Image field reference](fields-image.md).
