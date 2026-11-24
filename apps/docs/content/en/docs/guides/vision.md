---
title: Image understanding
description: Tell direct vision, the on-demand Vision model and image generation apart, and understand reference isolation, budgets and sending original files.
---

# Image understanding

Image behaviour splits into three independent paths. Telling them apart first keeps the rest of the settings in the right place:

| Path | Model used | Configured in |
| --- | --- | --- |
| Direct vision: images in new messages are attached to the main model | The **Agent** model (it must accept image input) | The model's capabilities in `providers`, see [Agent settings](../configuration/agent.md) |
| On-demand vision: older images and stickers are described by `read_image` | The **Vision** model (it may differ from the main model) | [Vision settings](../configuration/vision.md) |
| Drawing and editing | Image models on OpenRouter | [Image generation](image-generation.md), or the `image` section |

If you already know which path you need, jump straight to [Stickers and sticker sets](stickers.md) or [Image generation](image-generation.md).

## Direct vision versus the Vision model

These two are often confused:

- When the **main model accepts image input**, photos and supported image documents from the newest batch are attached to it directly. They are attached this once only and do not stay in later context.
- **Older images** and every sticker go through `read_image`, which asks the **Vision** model and returns a text description.
- Without Vision, `read_image` is unavailable, so historical images and stickers cannot be inspected; the sticker visual index also pauses (imported stickers stay pending instead of accumulating failures).
- Vision has its own model, thinking level, concurrency and daily budget (`max_tokens` and `max_images`); see [Vision settings](../configuration/vision.md) and the [`vision` field reference](../configuration/fields-vision.md).

## Which images the model can see

The model can only look at images and stickers that appeared in the current conversation and have not expired. Different chats, and different topics of one group, cannot see each other's images, and the model cannot read an image elsewhere by file ID or chat ID.

Images fetched during page reading follow the same isolation and expiry rules (up to 20 MiB each for JPEG, PNG and WebP); see [Web search and page fetching](web-search.md#page-fetching-and-images).

## Original files

Telegram compresses pictures sent as photos. Only when a user explicitly asks for "the original" or "as a file" does the model switch to `send` with `kind: file`:

- Ordinary pictures in the conversation: the copy Telegram stored. A regular photo was already compressed when it was uploaded, so sending it as a file cannot recover more quality; a picture received as a file is forwarded unchanged.
- Pictures the bot generated: the original files produced by the image service (see [Image generation](image-generation.md#original-files)). Replying "send the original" to that picture sends every original of that delivery.
- Stickers are not supported, and the reason is stated.
- If the original has been cleaned up, the model says it is unavailable instead of substituting the compressed copy.
- Playground rooms have no file messages, so this does not work there.

## Cost and budget boundaries

- Images attached directly to the main model count toward the global daily budget (`agent.daily_budget.max_tokens`).
- In-chat `read_image` calls also count toward the daily budget, while background Vision analysis (such as sticker indexing) uses its own daily budget (`vision.daily_budget`).

Related pages: [Stickers and sticker sets](stickers.md), [Image generation](image-generation.md), [Vision settings](../configuration/vision.md), [Connect and switch models](models.md).
