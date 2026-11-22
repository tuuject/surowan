---
title: Images, stickers and image generation
description: Image understanding, stickers and sticker sets, plus image generation settings, the workbench, records and assets.
---

# Images, stickers and image generation

Image behaviour splits into three independent paths. Telling them apart first keeps the rest of the settings in the right place:

| Path | Model used | Configured in |
| --- | --- | --- |
| Direct vision: images in new messages are attached to the main model | The **Agent** model (it must accept image input) | The model's capabilities in `providers`, see [Agent settings](../configuration/agent.md) |
| On-demand vision: older images and stickers are described by `read_image` | The **Vision** model (it may differ from the main model) | [Vision settings](../configuration/vision.md) |
| Drawing and editing | The upstream image provider (the built-in OpenRouter adapter) | **Image settings**, or the `image` section |

## Direct vision versus the Vision model

These two are often confused:

- When the **main model accepts image input**, photos and supported image documents from the newest batch are attached to it directly, in the same order as the `figure_N` media lines in those messages. Attachments are not stored.
- **Older images** (including earlier `figure_N` entries) and every sticker go through `read_image`, which asks the **Vision** model and returns a text description.
- Without Vision, `read_image` is unavailable, so historical images and stickers cannot be inspected; the sticker visual index also pauses (imported stickers stay pending instead of accumulating failures).
- Vision has its own model, thinking level, concurrency and daily budget (`max_tokens` and `max_images`); see [Vision settings](../configuration/vision.md).

Images cannot be referenced freely: only `img_` / `stk_` references that this Conversation authorized and that have not expired can be read, references are isolated per Conversation, and they expire. Arbitrary file IDs or Chat IDs are never accepted.

## Stickers and sticker sets

The bot only sends stickers from the sets you allow. They live in `telegram.sticker_sets` and are managed on the **Bot sticker sets** page; changes apply immediately, with no restart.

<!-- screenshot: images/sticker-sets | The Bot sticker sets page: configured sets and the search index -->

### Adding, editing, removing

1. Choose **Add sticker set** and fill in the **Telegram sticker set**: the set name (letters, digits, underscores) or a `https://t.me/addstickers/…` share link.
2. Give it an **Alias**: it must start with a letter, may contain letters, digits, `_` and `-`, and is at most 64 characters.
3. Optionally add a **Note** (up to 500 characters): guidance written for the model, such as "use when teasing a friend; avoid in serious topics". The model sees each set's alias and note when choosing stickers.
4. After saving, the bot downloads the stickers from Telegram in the background and indexes them one by one; the page shows sync and index progress. **Indexing requires a configured Vision model.**

Rules that catch people out:

- **The Telegram set a row points at never changes.** To use a different set, remove this one and add the other.
- Editing only changes the alias and the note. Renaming or re-noting does not stop a reply in progress; the new text reaches the next batch.
- Adding or removing a set stops running replies so the next one sees the new list immediately.
- Removing only stops the bot from using those stickers. **The index is kept**, so adding the same set again needs no re-analysis.

### Index state

Below the sets, **Sticker search index** filters by set and index state (pending / failed / indexed) and searches descriptions or emoji. Each row shows the description, the model used, the failure count, the next retry, the update time and the analysis version. Failures retry with backoff (up to 6 hours), so "1 failure" is usually transient.

### How the model picks a sticker

The model sees a `<sticker_catalog>` with one line per set (alias, note, and `sticker id: emoji` entries). Emoji is only a coarse hint: to actually use a sticker it must call `search_stickers` (either checking candidate ids or searching semantically), receive an `stk_` reference, and send it with `send` and `kind: sticker`. Sticker references expire after a while.

## Image generation

### Enabling and configuring

Without an `image` section in `config.jsonc`, image generation is disabled: the bot runs normally, the model simply has no image tools, and the panel hides the image pages. Enabling it on the **Image settings** page is recommended:

<!-- screenshot: images/image-settings | Image settings with the feature enabled and a model added -->

1. Tick **Enable image generation**.
2. **Key source**: reuse a saved OpenRouter credential (for example the one you already stored on the Providers page) or enter a new API key. Leave an existing credential empty to keep it.
3. Search and select a model in **OpenRouter image model**, choose a **Provider**, and choose **Add selected model**. The model name, internal ID, routing tag, reference-image limit, output limit, aspect ratios and quality levels are filled in for you.
4. Every model card has a **Usage & prompt notes** field (up to 1000 characters) for the styles and prompt conventions this model suits. It is guidance for the chat agent, **never sent upstream**. Leave it empty for no preference, and never put a key in it.
5. Choose **Save and apply**. It takes effect immediately, with no restart.

Capabilities are the intersection of the chosen provider's metadata and what this project supports. Models that require a reference image, or that only output SVG, cannot be added yet, and the page says why. A failed catalogue fetch never clears the models you already configured.

A few behaviours:

- API key plaintext goes only into the **Keychain** (`key.json`) next to the configuration; `config.jsonc` keeps a credential reference.
- Turning the switch off deletes the whole `image` section, but the Keychain entry stays until you remove it on the **Keychain** page.
- Every change to `image` is hot-applied, including enabling and disabling.
- If the configuration file changed elsewhere, saving reports a conflict; reload and try again.
- When the settings page says enabled but the workbench still says disabled, look for `image_service_warning` in the log (an unreadable credential, for example), fix it, then apply the configuration from **Settings**.

Writing the section by hand works too; fields are in [Image generation settings](../configuration/image.md):

```jsonc
{
  "image": {
    "credentials": { "openrouter": { "env": "OPENROUTER_API_KEY" } },
    "models": [
      {
        "id": "gpt-image-1",
        "name": "GPT Image",
        "provider": "openrouter",
        "upstreamModel": "openai/gpt-image-1",
        "credentialRef": "openrouter",
        "providerTag": "openrouter",
        "capabilities": {
          "imageInput": true,
          "maxInputImages": 4,
          "maxOutputs": 4,
          "aspectRatios": ["auto", "1:1", "4:3"],
          "resolutionClasses": ["auto", "low", "medium", "high"]
        }
      }
    ]
  }
}
```

### Generating in chat

Once enabled, just ask in the conversation: "draw a neon street in the rain", or "repaint that photo as a watercolour". The model's actual flow is:

1. `list_image_models` to read the current model catalogue (capabilities and notes), plus `search_image_assets` when a known character, style or motif is involved. Neither call costs anything.
2. `image_generate` to submit the intent: prompt, model, aspect ratio, quality, output count and optional reference images. It returns a generation id right away.
3. Generation runs in the background (usually seconds to tens of seconds); when it finishes, a task receipt is injected into the conversation.
4. The model delivers the generation's undelivered outputs with `send` and `kind: image`: a single picture is sent as a photo, several become an album, with an optional caption.

Boundaries worth knowing:

- **Reference images come from exactly two channels**: `img_` references visible in this conversation, or library assets promoted with "the agent may use this asset". The second channel is judged by text only (name, description, category, keywords) because the model never sees the picture. Cross-conversation, expired or invented references are refused, and every submission re-checks that the asset is still visible and not archived.
- **At most 3 generations per invocation.** Replaying the same tool call (a resumed run, for example) returns the existing generation without billing again; clicking Generate again, or having the model submit again, creates a new billed generation.
- **Delivered pictures are not re-delivered by default**: the same output of the same generation is not sent twice because of a repeated call or a late receipt.
- **Asking for the original file** is covered below.
- A failed generation is explained in the model's own words; it does not retry in a loop, and there is no hidden image channel that bypasses `send`.
- Disabling image generation removes the capability from the model and the panel immediately; re-enabling restores it immediately.

### Original files

Telegram compresses pictures sent as photos. Only when a user explicitly asks for "the original" or "as a file" does the model switch to `send` with `kind: file`:

- Pictures the bot generated: the original files produced by the image service. Replying "send the original" to that picture sends every original of that delivery.
- Other pictures in the conversation: the copy Telegram stored. An ordinary photo was already compressed when it was uploaded, so sending it as a file cannot recover more quality; a picture received as a file is forwarded unchanged.
- Stickers are not supported, and the reason is stated.
- If the original has been cleaned up, the model says it is unavailable instead of substituting the compressed copy.
- A file send does not count as an image delivery, so it does not affect the duplicate-delivery rule.
- Playground rooms have no file messages, so this does not work there.

### The three panel pages

**Image generation** is the workbench:

<!-- screenshot: images/generate-workbench | The image workbench with an inline asset reference in the prompt -->

1. Write the prompt, or insert assets at the caret. References come from three places: the recent strip, the whole library searchable under **More**, or a new upload on this page.
2. Picking an asset inserts `{{image:<asset id>}}`. The **Referenced images** row next to the box adds and removes entries as you type; removing one deletes every reference to that asset.
3. Prompt assets (`{{prompt:…}}`) still expand in place. At submit time each `{{image:…}}` is replaced in place by an ordered label, `图 1`, `图 2` and so on (literally "image 1"), and that order is the order the pictures reach the image model.
4. **Resolve preview** shows the final prompt and costs nothing.
5. Pick a model, aspect ratio, quality and count, then submit. Outputs appear under **This run's outputs**. Every submit is a new, billed generation.

**Image generations** is the audit list:

<!-- screenshot: images/generation-record | A completed image generation record -->

Clicking a generation id opens its own detail page (or navigate to `/image-generations/<id>`): status, model, submission source (an admin or a specific conversation), each attempt's upstream request and usage, the final prompt, the output images and any error. Reference images are shown in the order they were submitted, keep the name they had then, and open at full size; an archived asset is still viewable, and a cleaned-up original says so. Failed generations can be retried with **Retry**.

**Image assets** holds prompt assets and the reference-image library:

<!-- screenshot: images/image-assets | Image assets with the agent-visibility toggle and AI extraction -->

- Generated pictures enter the library automatically; reference images can be uploaded (up to 20 MB each), edited and archived.
- The edit dialog changes the name, description, category and keywords (one line, up to 500 characters, comma separated) and toggles **Agent can use this asset**.
- That toggle is **off by default**. Turning it on puts the asset into every conversation's asset search, so chat agents can find it and use it as a reference image. This is the only way to make an asset usable across conversations.
- **Suggest with AI** asks the tool model to look at the picture and propose a name and keywords. It is a **billed** call, and it only fills the form: nothing is stored until you save. When the tool model cannot read images, the panel explains why, links to the tool model settings, and lets you pick an image-capable model for this one extraction (the choice is not saved).
- Saving submits only the fields you changed, so another admin's edit while the dialog was open is not silently overwritten.
- Archived assets disappear from the pickers and from the agent's search results; generations that already referenced them are unaffected.

## Retention, backup and cost

- Generation records and asset rows are cleaned up by `retention.online_days`; original files are removed with the data directory.
- `backup` snapshots the SQLite database and copies `<data_dir>/images` into a `.images/` directory next to the backup file, so a restore puts both back together. See [Upgrade, back up and restore](maintenance.md).
- Cost has three separate places: each generation is billed by the upstream provider at its own prices (locally there is no extra quota, only the "at most 3 submissions per invocation" gate); **Suggest with AI** and dictionary merge spend Tool model tokens; **Vision** has its own daily budget (`vision.daily_budget`).

Related pages: [Image generation settings](../configuration/image.md), [Vision settings](../configuration/vision.md), [Model metadata catalog](../configuration/models-dev.md), [Upgrade, back up and restore](maintenance.md), [Try personas and tools in the Playground](playground.md).
