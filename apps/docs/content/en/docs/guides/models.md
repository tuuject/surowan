---
title: Connect and switch models
description: Add a provider, fetch its models, assign the Agent, Vision and Tool roles, and prove with a health check that the model replies.
---

# Connect and switch models

The panel splits model work across two pages: **Providers** owns connections and the model list, **Models** owns who does which job. A provider comes first; only then is there anything to assign.

## 1. What each page does

| Page | What you do there | How a change applies |
| --- | --- | --- |
| **Providers** | Create a connection, enter key and endpoint, fetch or add models, edit model details, run health checks | Applied as soon as you save; a reply already in progress finishes with the old settings |
| **Models** | Choose a model and thinking effort for Agent, Vision and Tool model | Written and applied together when you press **Save** in the bottom bar |

Every model row on Providers also has a **Use as** group (Agent / Vision / Tool): one click hands that job to the model, and a pressed button is the role it already fills. It is a shortcut; thinking effort is still set on Models.

## 2. Add a provider and its models

1. **Providers → New provider**, a three-step wizard:
   - **Connection**: choose **Built-in provider** (endpoint and API format are preset; pick the service) or **Custom endpoint** (enter the URL yourself, for relays or your own gateway).
   - **API key**: paste the key. **Custom headers** are only needed when the provider explicitly asks for them.
   - **Models**: **Fetch models** and tick the ones to enable. Models the listing does not return can be **Add manually** by ID.
2. Only ticked (or manually confirmed) models are written to the configuration. Everything else the provider lists does not exist for the runtime.
3. Creating a provider applies immediately. Select it to change the URL, API format, key or headers; **after changing the base URL you must re-enter the API key and every header value in the same save**, so an old secret is never sent to a new address.
4. Deleting a provider or model that still fills a role is refused: reassign the role or untick it first.

**API format** decides the shape of the request: OpenAI (Chat Completions), OpenAI (Responses), Anthropic, Google. Pick OpenAI (Chat Completions) when unsure — most services speak it; OpenAI (Responses) is supported by few.

## 3. Where model details come from

When you add a model, the panel looks up its details by ID: first the provider's own listing (OpenRouter, Vercel, Gemini), then [models.dev](https://models.dev).

- **Exact match**: context length, max output, accepted input and thinking levels are filled in; nothing needs confirming.
- **Price**: the provider's own price when it has one; otherwise the highest listed price across deployments in models.dev (input, output, cache read and cache write independently); otherwise 0. Price is never something you must confirm, and you can edit it later.
- **Thinking unknown**: the model is added as one that does not think, and the row says so.
- **Only context length, max output or accepted input missing** (or only a similar name matched) marks the model **N to confirm**; open the edit dialog and fill in or confirm the **to confirm** items before adding it.

**Nickname** (1–64 characters) only changes how Telegram commands display the model: with one set, `/status`, `/model` and `/effort` show just the nickname instead of the provider and real model ID; without one they show `provider / model`. The panel always shows the real ID.

For a mirror or an offline network, point the catalog elsewhere: **Developer → Model details source** writes `models_dev.api_url`; empty means the default `https://models.dev/api.json`. It accepts an HTTP(S) URL without credentials or a `#` fragment, and the mirror must serve the same JSON. It applies to the next lookup without a restart. Field details: [Model metadata catalog](../configuration/models-dev.md).

![The Providers page with a provider whose models were fetched](__DOCS_BASE__/screenshots/models/providers-list.en.light.png)

## 4. Assign the three roles

**Models** has three cards with different jobs:

| Card | What it does | If it is not set |
| --- | --- | --- |
| **Agent model** | Reads chats and private messages and decides how to reply | No run ever starts; the bot does not reply |
| **Vision model** | Describes images and stickers; `read_image` and sticker indexing depend on it | Both are unavailable |
| **Tool Model** | Background work such as dictionary merges and group-memory consolidation | Follows the Agent model |

- The Agent model only needs text input. Whether it can also receive images directly is a separate capability from the Vision model: a multimodal Agent reads new images itself, while the Vision model is what looks closely at one image and indexes stickers.
- Vision is optional. Without it the bot still chats; it just cannot examine an image on demand or index stickers.
- Thinking effort lists only the levels that model actually accepts; a model that does not think cannot be adjusted. If a model switch leaves a chat on a level the new model rejects, it resets to the weakest supported level (usually `off`).
- Nothing is written until you press **Save**: a changed card gets a dot in its title and the bottom bar counts the unsaved changes. **Discard changes** restores the saved values.

**What switching the Agent model does**: if runs are still using the old model, a dialog named **Stop running invocations and switch?** lists how many. Confirming (**Stop and switch**) stops them right there; the messages they were answering get no reply, previously delegated tasks are unaffected, and later messages go to the new model. Cancelling saves nothing.

The one exception is a hand-edited file applied from Settings: then a running invocation finishes on the old model. `/model` in Telegram also switches only that chat's model and does not ask — its reply says how many sessions it stopped.

## 5. Health check

Select a provider on **Providers** and press **Test** on a model row. To test several, tick the checkboxes (across providers, if you like) and press **Test**. At most three requests are in flight; each row reports its own result.

- This is a real model call and may cost money, but it changes no role and sends no persona prompt or chat history.
- The only prompt is `reply with extract content: ok`; each check waits at most 30 seconds and never retries.
- **OK**: the model finished normally with non-empty text, and the row shows **Model reply** with the model's own words. It need not echo `ok`; any normal answer passes.
- **Failed**: the request failed, timed out, returned nothing or did not finish normally; expand the row for the error and any partial text.
- **First response** is when the adapter saw the HTTP response headers — not the first generated token, and not the total time. When the adapter cannot observe it, it shows **unavailable**.
- Results live only on the page: refreshing or leaving clears them, and leaving cancels checks that have not started. Usage is recorded as a `doctor` diagnostic call in the audit.

If the provider or model was edited but not applied, the health check refuses outright, so you never test something other than the running configuration.

![A health check result: status, timing and the model's reply text](__DOCS_BASE__/screenshots/models/provider-health-check.en.light.png)

## 6. Field reference

The panel covers day-to-day work; exact fields, defaults and how they apply live in:

- [Providers and models](../configuration/providers.md): `kind`, `base_url`, `api`, `api_key`, `nickname`, `thinking_levels`, cost — field by field in the [`providers` field reference](../configuration/fields-providers.md)
- [Model metadata catalog](../configuration/models-dev.md): `models_dev.api_url`, field by field in the [`models_dev` field reference](../configuration/fields-models-dev.md)
- [Agent settings](../configuration/agent.md): the Agent triple and its budget, field by field in the [`agent` field reference](../configuration/fields-agent.md)
- [Vision settings](../configuration/vision.md): the Vision model and `thinking_level`, field by field in the [`vision` field reference](../configuration/fields-vision.md)
- [Tool model settings](../configuration/tool-model.md): the auxiliary model, field by field in the [`tool_model` field reference](../configuration/fields-tool-model.md)

![The Models page: three roles and the bottom save bar](__DOCS_BASE__/screenshots/models/model-roles.en.light.png)

## 7. Common problems

- **No model list after creating a provider**: a wrong key, a URL missing `/v1`, or headers the service requires. Try **Add manually** with a model ID you know exists — that separates a connection problem from a catalog problem.
- **Models are added but the bot does not reply**: check that the Agent model was saved on **Models**, then press **Test**. When the health check fails, do not guess model names; read the provider's error.
- **Behaviour changed after a model switch**: models differ a lot in tool use and instruction following, especially at different thinking efforts and context lengths. Re-run a few scenes from [Your first persona](first-persona.md); it is faster than rewriting the prompt.
