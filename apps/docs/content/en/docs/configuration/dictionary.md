---
title: Dictionary settings
description: The three dictionary injection modes, how a Chat override wins over the global value, and how injected entries reach the context.
---

# Dictionary settings

The `dictionary` section has exactly one field: the automatic injection mode. It decides which dictionary entries ride along with each message batch. The entries themselves (term, aliases, definition, global or per-group scope) live in the database and are maintained from the panel's **Dictionary** page, MCP or the HTTP API — never in the configuration file.

## When it matters

The dictionary is Telegram-only, and only for chats listed in the configuration. An unconfigured group gets no injection and no lookup tools.

Scope differs by chat type: a private chat reads only global entries, a group reads global plus its own entries, and one group never sees another group's entries.

## Injection modes

| Value | Behaviour |
| --- | --- |
| `off` | Nothing is injected. The agent can still look entries up with a tool. |
| `on_demand` | Entries whose term or alias appears in this batch's message text are injected. This is what you get when the section is absent. |
| `aggressive` | Preloads the whole effective dictionary for the scope, so the agent needs fewer lookups. |

The panel calls them **Off**, **On Demand** and **Aggressive**.

Matching is literal substring containment, not tokenisation: a term or alias counts when it appears anywhere in the text, and the layout space people put between Han characters and Latin words is tolerated (`AB 钙` matches `AB钙`). Case and word order are kept as written.

## Override order

Highest first:

1. `telegram.chats[].dictionary_injection_mode` (this chat's own override)
2. `dictionary.injection_mode` (global)
3. `on_demand` (product default)

All three may be omitted; the result equals writing `on_demand` explicitly.

```jsonc
{
  "dictionary": {
    "injection_mode": "aggressive"
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "dictionary_injection_mode": "off"
      }
    ]
  }
}
```

Every group preloads by default, and only `-1001234567890` has automatic injection turned off. Delete the chat field to drop the override and inherit the global value again.

## What the injected block looks like

In every mode the injection is:

- one block wrapped in `<untrusted_dictionary>` tags, placed between the sticker catalog and the history messages;
- one line per entry, tagged with the entry's id and revision;
- trimmed to the remaining context budget — this batch's new messages win, entries that do not fit are dropped;
- **deduplicated against the Context**: entries whose exact id-and-revision tag is still present in the retained transcript are skipped. A context GC that drops that batch makes them injectable again, and an edited entry carries a new revision, so it refreshes on the next batch.

The block is data, never instructions: entries are written by people and grant no authority.

## How it takes effect

Both `dictionary.injection_mode` and `telegram.chats[].dictionary_injection_mode` are hot. The next apply reaches the next message batch without a restart. Switching modes does not interrupt a running Invocation, because injection is computed per batch when the context is assembled.

## Example (global value only)

```jsonc
{
  "dictionary": {
    "injection_mode": "on_demand"
  }
}
```

## Interactions

- Adding, editing, merging and importing entries: [Manage memory and the dictionary](../guides/knowledge.md).
- A group-scoped entry needs the chat to exist in `telegram.chats`: [Telegram settings](telegram.md).
- Injected text spends Context budget; the budget fields are in [Agent settings](agent.md).

Types and enumerations: [Dictionary field reference](fields-dictionary.md).
