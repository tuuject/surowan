---
title: Vision settings
description: The model pair used for image and sticker analysis, the thinking_level default rule, separate concurrency and budget, the degraded state without a model, and the deprecated concurrency field.
---

# Vision settings

`vision` decides who looks closely at images: on-demand `read_image` analysis and the background sticker index both use it. It is separate from the main agent — a multimodal agent model sees images in new messages directly and does not need Vision; configure this section when a dedicated model should inspect images on demand.

`vision` is optional, and omitting it, writing `null` or writing a partial object are all legal. See the [`vision` field reference](fields-vision.md).

## The model pair

`provider` and `model` enable the feature only when both are written. With just one, `check-config` only warns and the runtime treats it as "no vision model". With both, the model must exist under `providers`, accept `image` input, and `vision.max_output_tokens` may not exceed the `max_tokens` that model declares.

The smallest enabling example (with a model from your own provider):

```jsonc
{
  "vision": { "provider": "gateway", "model": "replace-with-your-text-and-image-model" }
}
```

Every other field has a default and can be omitted.

## thinking_level

`vision.thinking_level` is optional. When omitted, it is derived from the selected model:

- `low` if the model accepts it,
- otherwise the weakest level above `off` that the model accepts,
- a non-reasoning model only offers `off`, so no reasoning parameter is sent at all.

When written it is validated like any other level and must be accepted by the model, otherwise `check-config` fails. It is hot like `provider` and `model`; when the panel switches only the model, it deletes a stored level the new model does not accept and falls back to the rule above.

## Concurrency, cache and budget

| Field | Runtime default | Effect |
| --- | --- | --- |
| `max_output_tokens` | `2048` | Output ceiling of one vision analysis; may not exceed the model's own ceiling. |
| `max_concurrency` | `2` | Concurrent foreground `read_image` calls. |
| `prompt_version` | `1` | Part of the vision cache identity (`<provider>/<model>/prompt-<version>`); increment it when the description rules change. |
| `daily_budget.max_tokens` | `200000` | Daily token ceiling for the background sticker index. |
| `daily_budget.max_images` | `200` | Daily image ceiling for the background sticker index. |

Two things are easy to misread:

- **`daily_budget` only limits the background sticker index** (metered under `system`/`sticker_index`). A chat-triggered `read_image` counts against the global `agent.daily_budget.max_tokens`, not this one.
- **`max_concurrency` and `prompt_version` are restart fields**, read when the service is constructed. `provider`, `model`, `thinking_level` and `max_output_tokens` are hot and reach the next analysis.

## What happens without a model

Without a usable model pair the feature is not "broken", it degrades by default:

- `read_image` refuses every call with `vision_unconfigured` and writes no analysis row.
- Background sticker indexing pauses, leaving rows `pending` without accumulating failures or backoff.
- A multimodal agent model still receives newly injected images directly; only "look closer on demand" and "understand stickers" are unavailable.
- The stable system prompt switches to its "images cannot be checked" wording, and `{{ vision.* }}` template variables render as empty strings.
- `doctor` skips the vision probe and reports `vision: null`.

Completing the model pair and applying restores all of it immediately, without a restart.

## Deprecated field

`vision.background_sticker_concurrency` is kept for upgrade compatibility only: the Schema still accepts it (it used to allow only `1`) and nothing reads it, so delete it. It has no replacement — the background index's concurrency is an implementation detail that is no longer configurable. While present it produces a load warning and shows up on the panel's Warnings page; see [configuration lifecycle](lifecycle.md).

## How changes take effect

`vision.provider`, `model`, `thinking_level` and `max_output_tokens` are hot; `max_concurrency`, `prompt_version` and `daily_budget` need a restart. After a model change the same image is analyzed again under the new cache identity; stickers that are already indexed are not re-run.
