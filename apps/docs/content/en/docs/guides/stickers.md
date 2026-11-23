---
title: Stickers and sticker sets
description: Add and manage allowed Telegram sticker sets in the Admin Panel, inspect Vision index state, and see how the model searches and sends stickers.
---

# Stickers and sticker sets

The bot only sends stickers from the sets you allow. They live in `telegram.sticker_sets` and are managed on the **Telegram → Bot sticker sets** page; changes apply immediately, with no restart.

![The Bot sticker sets page: configured sets and the search index](__DOCS_BASE__/screenshots/images/sticker-sets.en.light.png)

## Adding, editing, removing

1. Choose **Add sticker set** and fill in the **Telegram sticker set**: the set name (letters, digits, underscores) or a `https://t.me/addstickers/…` share link.
2. Give it an **Alias**: it must start with a letter, may contain letters, digits, `_` and `-`, and is at most 64 characters.
3. Optionally add a **Note** (up to 500 characters): guidance written for the model, such as "use when teasing a friend; avoid in serious topics". The model sees each set's alias and note when choosing stickers.
4. After saving, the bot downloads the stickers from Telegram in the background and indexes them one by one; the page shows sync and index progress. **Indexing requires a configured Vision model** (see [Image understanding](vision.md) and [Vision settings](../configuration/vision.md)).

Rules that catch people out:

- **The Telegram set a row points at never changes.** To use a different set, remove this one and add the other.
- Editing only changes the alias and the note. Renaming or re-noting does not stop a reply in progress; the new text reaches the next batch.
- Adding or removing a set stops running replies so the next one sees the new list immediately.
- Removing only stops the bot from using those stickers. **The index is kept**, so adding the same set again needs no re-analysis.

## Index state

Below the sets, **Sticker search index** filters by set and index state (pending / failed / indexed) and searches descriptions or emoji. Each row shows the description, the model used, the failure count, the next retry, the update time and the analysis version. Failures retry with backoff (up to 6 hours), so "1 failure" is usually transient.

Without a Vision model configured, visual indexing pauses automatically and imported stickers stay pending rather than accumulating failures.

## How the model picks a sticker

The model sees a `<sticker_catalog>` with one line per set (alias, note, and `sticker id: emoji` entries). Emoji is only a coarse hint: to actually use a sticker it must call `search_stickers` (either checking candidate ids or searching semantically), receive an `stk_` reference, and send it with `send` and `kind: sticker`. Sticker references expire after a while.

Whether a lone sticker sent in a group wakes the bot is controlled by `telegram.sticker_trigger_enabled`; see [Telegram settings](../configuration/telegram.md).

Related pages: [Image understanding](vision.md), [Image generation](image-generation.md), [Vision settings](../configuration/vision.md), [Telegram settings](../configuration/telegram.md).
