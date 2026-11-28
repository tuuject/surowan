---
title: Image generation
description: Enable and configure image generation models, draw or request original files in chat, use the workbench, records and asset library, and understand backups and billing.
---

# Image generation

Image generation is an optional capability separate from [Image understanding](vision.md), currently provided through image models on OpenRouter.

## Enabling and configuring

Without an `image` section in `config.jsonc`, image generation is disabled: the bot runs normally, the model simply has no image tools, and the panel hides the image pages. Enabling it on the **Media → Image settings** page is recommended:

![Image settings with the feature enabled and a model added](__DOCS_BASE__/screenshots/images/image-settings.en.light.png)

1. Tick **Enable image generation**.
2. **Key source**: reuse a saved OpenRouter credential (for example the one you already stored on the Providers page) or enter a new API key. Leave an existing credential empty to keep it.
3. Search and select a model in **OpenRouter image model**, choose a **Provider**, and choose **Add selected model**. The model name, internal ID, routing tag, reference-image limit, output limit, aspect ratios and quality levels are filled in for you.
4. Every model card has a **Usage & prompt notes** field (up to 1000 characters) for the styles and prompt conventions this model suits. It is guidance for the chat agent, **never sent upstream**. Leave it empty for no preference, and never put a key in it.
5. Choose **Save and apply**. It takes effect immediately, with no restart.

What a model can actually do (ratios, quality tiers and so on) is limited to what the chosen provider advertises and what Surowan supports. Models that require a reference image, or that only output SVG, cannot be added yet, and the page says why. A failed catalogue fetch never clears the models you already configured.

A few behaviours:

- API key plaintext goes only into the **Keychain** (`key.json`) next to the configuration; `config.jsonc` keeps a credential reference.
- Turning the switch off deletes the whole `image` section, but the Keychain entry stays until you remove it on the **Keychain** page.
- If the configuration file changed elsewhere, saving reports a conflict; reload and try again.
- When the settings page says enabled but the workbench still says disabled, look for `image_service_warning` in the log (an unreadable credential, for example), fix it, then apply the configuration from **Settings**.

Writing the section by hand works too; fields are in [Image generation settings](../configuration/image.md) and the [`image` field reference](../configuration/fields-image.md):

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

## Generating in chat

Once enabled, just ask in the conversation: "draw a neon street in the rain", or "repaint that photo as a watercolour". The model's actual flow is:

1. `list_image_models` to read the current model catalogue (capabilities and notes), plus `search_image_assets` when a known character, style or motif is involved. Neither call costs anything.
2. `image_generate` to submit the intent: prompt, model, aspect ratio, quality, output count and optional reference images. It returns a generation id right away.
3. Generation runs in the background (usually seconds to tens of seconds); when it finishes, the model is notified.
4. The model delivers the generation's undelivered outputs with `send` and `kind: image`: a single picture is sent as a photo, several become an album, with an optional caption.

Boundaries worth knowing:

- **Reference images come from exactly two channels**: `img_` references visible in this conversation, or library assets promoted with "the agent may use this asset". The second channel is judged by text only (name, description, category, keywords) because the model never sees the picture. Cross-conversation, expired or invented references are refused, and every submission re-checks that the asset is still visible and not archived.
- **At most 3 generations in progress at once per invocation.** Each finished generation frees its slot, so asking for one revision after another never runs out; a fourth request sent while three are still running waits until one of them finishes. Resuming a failed run does not redo a generation it already submitted, and does not bill again; clicking Generate again, or having the model submit again, creates a new billed generation.
- **Delivered pictures are not re-delivered by default**: the same output of the same generation is not sent twice because of a repeated call or a late receipt.
- **Asking for the original file** is covered below.
- A failed generation is explained in the model's own words; it does not retry in a loop.
- Disabling image generation removes the capability from the model and the panel immediately; re-enabling restores it immediately.

## Original files

Telegram compresses pictures sent as photos. Only when a user explicitly asks for "the original" or "as a file" does the model switch to `send` with `kind: file`:

- Pictures the bot generated: the original files produced by the image service. Replying "send the original" to that picture sends every original of that delivery.
- If the original has been cleaned up, the model says it is unavailable instead of substituting the compressed copy.
- A file send does not count as an image delivery, so it does not affect the duplicate-delivery rule.
- Playground rooms have no file messages, so this does not work there.

For ordinary chat photos and stickers, see [Image understanding](vision.md#original-files).

## The three panel pages

**Image generation** is the workbench:

![The image workbench with an inline asset reference in the prompt](__DOCS_BASE__/screenshots/images/generate-workbench.en.light.png)

1. Write the prompt, or insert assets at the caret. References come from three places: the recent strip, the whole library searchable under **More**, or a new upload on this page.
2. Picking an asset inserts `{{image:<asset id>}}`. The **Referenced images** row next to the box adds and removes entries as you type; removing one deletes every reference to that asset.
3. Prompt assets (`{{prompt:…}}`) still expand in place. At submit time each `{{image:…}}` is replaced in place by an ordered label, `图 1`, `图 2` and so on (literally "image 1"), and that order is the order the pictures reach the image model.
4. **Resolve preview** shows the final prompt and costs nothing.
5. Pick a model, aspect ratio, quality and count, then submit. Outputs appear under **This run's outputs**. Every submit is a new, billed generation.

**Image generations** is the audit list:

![A completed image generation record](__DOCS_BASE__/screenshots/images/generation-record.en.light.png)

Clicking a generation id opens its own detail page (or navigate to `/image-generations/<id>`): status, model, submission source (an admin or a specific conversation), each attempt's upstream request and usage, the final prompt, the output images and any error. Reference images are shown in the order they were submitted, keep the name they had then, and open at full size; an archived asset is still viewable, and a cleaned-up original says so. Failed generations can be retried with **Retry**.

**Image assets** holds prompt assets and the reference-image library:

![Image assets with the agent-visibility toggle and AI extraction](__DOCS_BASE__/screenshots/images/image-assets.en.light.png)

- Generated pictures enter the library automatically; reference images can be uploaded (up to 20 MiB each), edited and archived.
- The edit dialog changes the name, description, category and keywords (one line, up to 500 characters, comma separated) and toggles **Agent can use this asset**.
- That toggle is **off by default**. Turning it on puts the asset into every conversation's asset search, so chat agents can find it and use it as a reference image. This is the only way to make an asset usable across conversations.
- **Suggest with AI** asks the tool model to look at the picture and propose a name and keywords. It is a **billed** call, and it only fills the form: nothing is stored until you save. When the tool model cannot read images, the panel explains why, links to the tool model settings, and lets you pick an image-capable model for this one extraction (the choice is not saved).
- Saving submits only the fields you changed, so another admin's edit while the dialog was open is not silently overwritten.
- Archived assets disappear from the pickers and from the agent's search results; generations that already referenced them are unaffected.

## Retention, backup and cost

- Generation records and asset records are cleaned up by `retention.online_days`; original files are removed with the data directory.
- `backup` snapshots the SQLite database and copies `<data_dir>/images` into a `.images/` directory next to the backup file, so a restore puts both back together. See [Upgrade, back up and restore](maintenance.md).
- Each generation is billed by the upstream provider at its own prices (locally there is no extra quota, only the "at most 3 in progress at once per invocation" gate); **Suggest with AI** spends Tool model tokens.

Related pages: [Image understanding](vision.md), [Stickers and sticker sets](stickers.md), [Image generation settings](../configuration/image.md), [Model metadata catalog](../configuration/models-dev.md), [Upgrade, back up and restore](maintenance.md), [Try personas and tools in the Playground](playground.md).
