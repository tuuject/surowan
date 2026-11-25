---
title: Tool model settings
description: What the system-wide helper model is used for, how it inherits the global agent, why it ignores per-Chat overrides, and a ready-to-use example.
---

# Tool model settings

`tool_model` is the **system-wide** helper model. It never participates in a conversation; it runs small background tasks shared by every chat. See the [`tool_model` field reference](fields-tool-model.md).

## Who uses it

| Task | What it does |
| --- | --- |
| Dictionary merge | Merges several candidate entries into one suggestion; the result is only a suggestion that still needs human confirmation. |
| Group memory consolidation | Turns a quiet chat's messages into dated event summaries with message-id ranges. |
| MCP description drafting | Drafts the description a progressive MCP server shows the model, for a human to confirm. |
| Image asset AI extraction | Extracts an asset name and keywords from a reference image. |

The first three require `text` input only. Asset extraction needs both `image` and `text`, so an inherited text-only model may not be enough — the panel can point one extraction at another image-capable model without touching the `tool_model` configuration.

## Inheritance

The whole section may be omitted. When it is, `tool_model` **inherits the global agent** — `provider`, `model` and `thinking_level` together, never a per-field mixture.

The important part is what it does *not* inherit: per-Chat overrides. A chat that switches its own conversation model never changes a system-wide helper call, because otherwise one group's settings would silently change dictionary merges or group-memory consolidation for the whole instance. Inheritance reads the global `agent` section only.

If the global triple is also incomplete and `tool_model` is not configured, there is no helper model: features that need one report "not configured" instead of falling back to some arbitrary model.

## Configuration

All three fields are required and follow the same rules as the agent's:

```jsonc
{
  "tool_model": { "provider": "gateway", "model": "replace-with-your-text-and-image-model", "thinking_level": "off" }
}
```

- `provider` + `model` must name a registered model under `providers` that accepts `text` input.
- `thinking_level` must be a level that model accepts; a non-reasoning model only takes `off`.
- Validation runs in `check-config` and on every configuration apply, so an invalid combination is rejected up front instead of failing on the first helper call.

## Effect and restoring inheritance

`tool_model` is hot: the next helper call uses the new selection while a call already running keeps the model it started with. To restore inheritance, delete the whole `tool_model` section and apply; on the panel's Models page, restoring inheritance on the Tool Model card deletes exactly that section.

Choosing the model and its thinking level in the panel is covered in [connect and switch models](../guides/models.md).
