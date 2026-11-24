---
title: Manage memory and the dictionary
description: Tell continuous Context, Memo Pad, group memory and the dictionary apart, and maintain their entries, progress, 30-hour clock and imports.
---

# Manage memory and the dictionary

Surowan keeps four different kinds of remembered material, and they answer different questions:

- **Context** remembers the conversation itself.
- **Memo Pad** holds notes the model chose to write down.
- **Group memory** records what happened in this group before.
- **The dictionary** explains what a word means here.

All four are scoped to a Chat: every Forum Topic of a group shares one Memo Pad, one group memory and one dictionary, a private chat has its own, and different Chats cannot read each other. Only Context is per Conversation (one per Topic). For the surrounding boundaries, see [Set boundaries per chat and topic](chats.md).

## The four layers at a glance

| Layer | Written by | How it reaches the conversation | Where in the panel |
| --- | --- | --- | --- |
| Context | The real chat messages, plus status information Surowan adds | Attached to every run automatically | **Contexts**, read-only |
| Memo Pad | The model, with `add_memo` / `update_memo` / `delete_memo`; an admin can also edit entries in the panel | Short-term entries are injected; long-term entries need the model to call `search_memory` | **Memories** |
| Group memory | A background pass once the group goes quiet, using the Tool model | On demand: `search_group_memory`, then `read_group_messages` for the raw messages | **Group memory** |
| Dictionary | Admins, or the model for **this group's** entries | Injected automatically according to the injection mode, or looked up with `lookup_dictionary` | **Dictionary** |

## Context: nothing to maintain

One Conversation has exactly one continuous history for its whole life. It is never summarized; it only drops the oldest part when it grows too long, and those thresholds live under `agent.context`, described in [Agent settings](../configuration/agent.md) and the [`agent` field reference](../configuration/fields-agent.md).

Two practical consequences:

- You never have to do anything to make the model remember what was just said — that is Context's job.
- Switching models, editing the persona prompt, or changing the tool set rebuilds Context on the **next** run. It never deletes Memo Pad entries, group memory or dictionary entries. Only deleting the Chat removes those.

## Memo Pad: notes the model chose to keep

Every entry has two parts:

- **Summary**: at most 150 characters. Lists, search results and automatic injection show exactly this, so it should say **what the entry stores**, not why it was saved.
- **Detail**: up to 32,768 characters of Markdown, returned only when the entry is actually read. Images are referenced as `pwblob://` URIs.

### Short-term and long-term entries

The writer decides the lifetime, and the lifetime decides how the entry comes back:

| | Lifetime | Behaviour |
| --- | --- | --- |
| Short-term | Has an expiry | Injected automatically while valid; once expired it is no longer injected and retention cleanup deletes it |
| Long-term | No expiry | Never injected; the model finds it with `search_memory` and reads it with `read_memory` |

The injection details explain the occasional "why did the bot forget what I just told it":

- Valid short-term entries are listed for the model in creation order, within roughly 10% of the context window. When that is not enough, the oldest entries are hidden and the number hidden is stated, so the model can search for them.
- The full list is not repeated every time. It reappears only at the start of a conversation, after a Context rebuild, or once the previous copy has been dropped with old history; otherwise the model is only told what was added, changed or removed, and nothing is sent when nothing changed.

### How the model reads and writes

- `search_memory` and `read_memory` are tools the model calls directly. Search matches summary and detail text case-insensitively; with several keywords at least half must match, and you can filter by creation time.
- `add_memo`, `update_memo`, `delete_memo` and `save_memo_image` show up in tool sessions as an `execute` tool call.
- An update must be preceded by `read_memory` of the current revision. If the entry changed after that read (in the panel too), the write is refused and must be re-read. Deleting does not require a prior read.
- The model can only read and write the current Chat's entries. Once the Chat is removed from the configuration, writes are refused.

### Image attachments

`save_memo_image` saves a copy of one image visible in the conversation as an attachment owned by this Chat; the model then writes it (a `pwblob://` address) into the detail. Worth knowing:

- One image is at most 10 MiB, deduplicated by content within the Chat.
- Attachments belong to the Chat, not to an entry. One is deleted only when no entry's detail references it any more.
- The image in the chat stops being readable by the model after a while; the saved attachment does not.
- Viewing these images in the panel requires being signed in. HTML inside a detail is never executed.

### Maintaining entries in the panel

Open **Memories**:

![The memo editor on the Memories page](__DOCS_BASE__/screenshots/knowledge/memo-editor.en.light.png)

1. Filter by Chat and **State**: **Active**, **Expired**, **Short-term**, **Long-term**. The list shows summaries only; **View** opens the full detail.
2. **New memo** asks for a Chat, a summary, a detail (Markdown is supported) and a **Lifetime in days**.
3. Leave the lifetime empty to keep the entry permanently; otherwise enter 1–1825 days. Changes apply from the next invocation.
4. Deleting asks for confirmation; images used only by that memo are deleted with it.

### When to use Memo Pad

- Durable material a group member handed over: preferences, agreements, supply lists.
- Facts that must apply across Topics (all Topics of a Chat share the same Memo Pad).
- Never store tokens, API keys or other credentials in it.
- Rules everyone must follow belong in the persona prompt or a chat's instruction file, not only in a memo.

## Group memory: what happened in this group

Group memory is off by default and enabled per Chat. Two ways to enable it, with the same effect:

- On the **Chats** page, open the group-memory dialog of that row and tick **Enable group memory for this Chat**.
- Add a `group_memory` object to the chat's entry in `telegram.chats[]`:

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "group_memory": { "enabled": true, "idle_minutes": 30 }
      }
    ]
  }
}
```

Turning it on or off stops the Chat's running invocations and rebuilds its Context, because the recall tools are part of the tool set.

### How consolidation happens

After a Chat has been quiet for a while, a background pass hands one local day of unprocessed messages to the Tool model and writes event summaries, each carrying an inclusive Telegram message-id range:

```text
- gmem_… [2026-10-01; messages 4005-4114]: Natu and tcdw discussed eSIM prices.
```

When a pass may run:

- A local day that has ended is consolidated without waiting.
- The current day waits until the Chat has been quiet for `idle_minutes` (default 30, range 1–1440).
- Only messages received **after** group memory was switched on are consolidated. Earlier history, and anything said while it was off, is skipped.
- One batch covers one local day: at most 120 messages and roughly 40,000 characters, up to 50 events, each summary capped at 200 characters (the prompt asks for 150).

A pass is skipped, and simply tries again later, when:

- Another run is queued or running for that Chat, or a message batch is still collecting (consolidation never competes with a reply in progress).
- Someone ran `/pause` in the group; `/resume` continues, and the backlog built up during the pause is consolidated.
- The installation is in a global `zzz` sleep: background consolidation is a paid model call and does not start.
- No Tool model is available (not configured, and no global Agent model to inherit).

### Two lanes and failure handling

- The **live** lane follows new messages. When it falls more than a day behind (an outage, repeated model failures), everything before yesterday is handed to the **backfill** lane, so yesterday and today do not have to wait for the backlog. The two lanes never overlap or skip messages.
- When the model's reply is invalid, the request is repeated once with the reason attached; if it is still invalid, that batch retries after 30 minutes without blocking other batches or the Chat's other lane.
- Consolidation runs on the system-wide **Tool model**, which falls back to the global Agent model when unset, and does not count against the daily Agent token budget.

### How the model recalls

Recall has two layers, and the model decides when to use them:

1. `search_group_memory` by Chat-local date, keywords, or a limit. It returns summaries and message ranges only; summaries are never injected, so they cost no ordinary context.
2. `read_group_messages` replays the raw messages of a range. Ranges are inclusive and bounded: too wide a range is refused, and truncated results say to narrow it.

Group memory is shared by the Chat and its Topics; summaries and raw messages of other Chats are invisible.

### Watching consolidation progress

Open **Group memory**. The top of the page is **Consolidation progress**:

![Consolidation progress at the top of the Group memory page](__DOCS_BASE__/screenshots/knowledge/group-memory-progress.en.light.png)

One row per Chat with group memory on, showing:

- **Status**: Consolidating / Healthy / Failing (N in a row), with the next retry time.
- **Consolidated through**: which message id and time the lane has reached.
- **Pending** and **Backfill**: how many messages are waiting, and how far the backfill lane has to go.
- **Last success** and **Last 24 hours**: how many batches succeeded and failed.

**View batches** lists that Chat's recent batches: start time, lane (Live or Backfill), the day and message count, the result (how many events, or a failure), model call count and the failure reason. When a Chat seems to have no memories, this is the first place to look.

### The 30-hour clock

Late-night conversation crosses midnight, so searching "what did we talk about last night" by calendar day splits it in two. A dated search can use a **30-hour clock** (off by default), borrowed from Japanese broadcasting, where a broadcast day runs until 06:00 the next morning.

Set it in the group-memory dialog on the **Chats** page, or in the configuration:

```jsonc
{
  "telegram": {
    "chats": [
      { "id": -1001234567890, "group_memory": { "enabled": true, "thirty_hour_clock": "non_overlapping" } }
    ]
  }
}
```

![The 30-hour clock setting in the group-memory dialog](__DOCS_BASE__/screenshots/knowledge/thirty-hour-clock.en.light.png)

| Value | What a dated search returns |
| --- | --- |
| `off` (default) | 00:00–24:00 of that date |
| `non_overlapping` | 06:00 that date to 06:00 the next date; consecutive dates never share an hour |
| `overlapping` | 00:00 that date to 06:00 the next date; the small hours also appear under the previous date |

Times are Chat-local, and DST days still split at the local 06:00. Every event belongs to the date of its first message; results keep the calendar date they were filed under and the reply opens by naming the hours searched. Only dated searches change: undated searches, consolidation and filing still use calendar days.

### Editing and deleting events

The event list filters by Chat, day and summary. For each event you can:

- **View source**: read the raw messages of the range (the display is capped).
- **Edit group memory**: only the summary (1–200 characters). The day and the message range are consolidation results and cannot be edited.
- **Delete**: the event disappears from recall and **the range is not summarized again**.

Group memory is deleted with the Chat. It is not touched by `retention.online_days`, so disk usage grows with conversation volume; delete the Chat, or prune events, when you need to reclaim it.

## The dictionary: what a word means here

The dictionary explains nicknames, abbreviations, slang and inside jokes. It is maintained separately from Memo Pad: a dictionary entry describes what an expression means, a memo stores facts, material or preferences. **Dictionary entries are data: they never grant tool authority and never replace the persona prompt.**

### Global and group scopes

- The **global** dictionary is readable in every conversation, private chats included.
- A **group** dictionary belongs to one Chat and is shared by its Topics; entries from other groups never appear in this Chat's lookups or injections.
- Private chats can only read global entries.

In a group, the model may look up global and this group's enabled entries and may **add or update entries of this group**; it cannot write global entries, edit another group's entries, or promote a group entry to global. Admins can maintain both scopes in the panel.

### Matching rules

- Matching is case-sensitive and literal. There is no semantic search, spelling correction or tokenization.
- The single relaxation is horizontal whitespace between a Han character and an ASCII letter or digit (the "pangu" spacing convention): `AB钙` and `AB 钙` match the same entry. Spaces between two Latin words and line breaks are not ignored, and stored terms keep their original spelling.
- Terms and aliases both match inside longer messages: the alias `碗` matches `今天碗怎么不说话了？`.
- When several entries match, all definitions are kept; a global entry never overrides a group entry.

### Automatic injection

A global injection mode can be overridden per Chat:

| Mode | Panel label | Behaviour |
| --- | --- | --- |
| `off` | Off | No automatic injection; the model can still look entries up |
| `on_demand` (default) | On demand | Inject entries whose term or alias appears in this batch's messages |
| `aggressive` | Aggressive | Preload the effective global and group entries |

Configure it in the **Automatic injection** area of the **Dictionary** page (the right column on wide screens): pick a scope in the scope panel first, then change the **Global mode** or that Chat's **override**, and apply.

Injection details:

- The injected block is trimmed to the context budget left after the messages were selected, so new messages always win over a preload.
- An entry that is still in the Context is not injected twice. It is injected again once that part of the Context has been dropped, or after the entry changes.
- The dictionary has no separate token budget; it is bounded by the model's context window.
- Disabling an entry stops future lookups and injections. An explanation already written into retained history stays there.

### Conflicts and AI merge

When two different entries end up with the same normalized term or alias — for example `AB钙` and `AB 钙` — the panel reports a potential conflict. The check covers term/term, term/alias and alias/alias pairs, including cross-scope conflicts between global and the selected group. A conflict **never** blocks saving, lookups or injection; keeping several meanings is allowed.

To tidy up, select two or more entries and choose **Merge selected**:

1. **Generate suggestion**: the Tool model merges the sources into one proposal.
2. Edit the proposed term, definition or aliases directly.
3. Choose whether to save it to the global dictionary or to a specific group.
4. Decide whether to **delete the source entries** (leave it off to keep every source and store the merged entry alongside them).
5. Confirm.

Generating a suggestion calls the **Tool model** (configured on **Models**, inheriting the global Agent model when unset) and **may cost money**. The suggestion alone changes nothing; if a source changed while you were reviewing, the panel warns and asks you to regenerate before saving.

### Bulk import and export

The **Import** and **Export** buttons at the top of the Dictionary page handle CSV and JSONL. Import asks for a target scope, reads a file or pasted text, shows a parse preview with potential conflicts, and writes only after you confirm. Import **only creates entries**: a matching name never overwrites or updates an existing entry.

![The dictionary import preview with the parsed row, its aliases and the conflict check](__DOCS_BASE__/screenshots/knowledge/dictionary-import.en.light.png)

CSV columns are `term`, `definition`, `aliases` and `enabled`. Several aliases in one cell are separated by `|`; a literal pipe inside an alias is written `\|` and a backslash `\\`. Cells containing commas, quotes or line breaks follow RFC 4180 (quote the cell, double the quotes):

```csv
term,definition,aliases,enabled
Surowan,What the group calls the bot,surowan|the bot,true
```

JSONL is one JSON object per line, with aliases as an array:

```jsonl
{"term":"Surowan","definition":"What the group calls the bot","aliases":["surowan","the bot"],"enabled":true}
```

Exporting a scope and importing the same file works, but the import creates new entries, so re-importing your own export can produce duplicates — check the preview. An export can contain group-specific wording; review it before sharing.

## Which one do I need?

- "Why doesn't it remember what I just said?" → check whether the Context was rebuilt.
- "Keep this for later" → Memo Pad: short-term if the model should always see it, long-term if it should search for it.
- "What did the group discuss last week?" → group memory.
- "What does this abbreviation mean?" → the dictionary.

## Common mistakes

- Memo Pad is not a global knowledge base: it is per Chat, shared by Topics, invisible across groups.
- A vague summary is unfindable; the summary is a search index, not the content.
- Long-term does not mean "more important", only "not injected". Facts the model must always know belong in a short-term entry.
- Group memory never backfills the history from before it was switched on, and deleting an event does not re-summarize that range.
- The dictionary has no semantic search, so list the usual spellings as aliases.
- Deleting messages or switching models never clears the Memo Pad.

Related pages: [Set boundaries per chat and topic](chats.md), [Connect and switch models](models.md), [Troubleshoot startup failures and silence](troubleshooting.md), [Tool model settings](../configuration/tool-model.md), [Telegram settings](../configuration/telegram.md).
