---
title: Set boundaries per chat and topic
description: Give each chat its own scope, model, extra instructions, timezone, ignore list, active hours, `/ask`-only mode, proactive replies, entry gate and MCP bindings — and know the difference between removing a chat and deleting its data.
---

# Set boundaries per chat and topic

Surowan only works in the chats listed in `telegram.chats`. The global section holds the defaults; each entry under `telegram.chats[]` overrides one chat. Fields you leave out keep inheriting the global value, and fields you write apply only to that chat.

Chat and Forum Topic are two different levels: a Topic inherits everything about its Chat (model, participation, MCP bindings), but **conversation context is per Chat + Topic**. Two topics in one group never see each other's conversation, while a settings change reaches all of them at once. Which fields a `telegram.chats[]` entry may set, with their types and defaults, is in the [`telegram` field reference](../configuration/fields-telegram.md).

## Scope: which chats are processed

- The chat must appear in `telegram.chats`. Telegram may deliver a message and Surowan still ignores it when the chat is not listed.
- Without `topic_ids`, ordinary messages and every Topic of the chat are allowed. With a non-empty list, only the listed positive Topic IDs are.
- Chat IDs are unique and non-zero: positive for private chats, negative for groups and supergroups.
- Extra instructions, model overrides, participation, the ignore list, group memory and MCP bindings all belong to the Chat and are shared by its Topics. Only the conversation context and the attention window are per Topic.

Add a chat with *Add Chat* on the **Chats** page: a Telegram Chat ID and an optional list of Topic IDs is all it needs, and it works as soon as you save.

![The Chats page listing an allowed chat and its topic scope](__DOCS_BASE__/screenshots/first-bot/chat-allowlist.en.light.png)

## What the Chats page does

The *More actions* menu at the end of each row groups the editors by purpose:

- **Chat settings**: *Edit active hours*, *Edit proactive reply chance*, *Edit entry gate*, *Edit group memory*.
- **MCP servers**: bind outbound MCP servers to this chat and narrow the tools it may call.
- **Open related pages**: jump to Prompts, Dictionary, Memories, Group memory, Messages, Tool sessions or Alarms with `?chat=<chat ID>`, which filters that list to this chat.
- **Remove**: remove the chat and delete its data, see below.

The *Status* column tells you whether a change is live. *Active* means the saved values are what is running; *Changes pending* means the file was written but a restart is still needed (typically for something like the topic scope); *Addition pending* and *Removal pending* mean the file and the running configuration disagree.

## Model and thinking effort per chat

Without `provider`, `model` and `thinking_level` a chat uses the global model. To override:

- `provider` and `model` must be set together, and the model must exist in that provider's `models` list with text input.
- Writing only `thinking_level` keeps the global model and overrides the effort; the effort must be one the current model supports.

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "topic_ids": [100, 200],
        "timezone": "Asia/Tokyo",
        "provider": "gateway",
        "model": "replace-with-your-text-and-image-model",
        "thinking_level": "off",
        "ignored_user_ids": [123456789],
        "participation": {
          "active_windows": [
            { "start": "19:00", "end": "24:00" },
            { "start": "22:00", "end": "01:00", "days": [5, 6] }
          ],
          "trigger_keywords": ["standby"],
          "attention_window_seconds": 600
        }
      }
    ]
  }
}
```

Switching the model in the panel asks for confirmation when the chat still has runs on the old model. Confirming stops them: the batch they were handling gets no reply and is not reprocessed, previously delegated tasks are unaffected, and the next messages are answered by the new model. Cancelling saves nothing. The new model continues with the existing context. Changing only the thinking effort never stops a run.

Group administrators can also use commands: `/model <index>` writes the chat override and `/model default` returns to the global model; `/effort <level>` changes only the effort and `/effort default` returns to inherited. Same effect, no confirmation dialog — the receipt states how many runs were stopped. See [Telegram commands](../developer/telegram-commands.md).

## Extra instructions per chat

A chat's extra instructions live on the **Prompts** page: pick the *Chat <id>* scope on the left and save. The first save creates the file and points `telegram.chats[].instructions_file` at it. These instructions are added on top of the global persona, not in place of it, and apply from the next run.

## Timezone

A chat's `timezone` decides which local time its active hours are read in; without it the top-level `timezone` applies. The panel only displays the current timezone (*Times shown in Asia/Tokyo, now …*) — it is a configuration field and changing it needs a restart.

## Ignore list and self-service commands

`ignored_user_ids` lists the members this chat no longer reacts to. Their ordinary messages, edits and other commands never reach the model and are not stored as chat history. Only `/ask`, `/help` and the two self-service commands below are exempt.

Members can add and remove themselves without an administrator:

| Command | Effect |
| --- | --- |
| `/ignoreme` | Adds the sender's own ID to this chat's ignore list, effective immediately. |
| `/unignoreme` | Removes it again; works while ignored too. |
| `/ask <question>` | Any member can call the bot explicitly, including ignored members. |

These commands only change the sender, apply to every Topic of the chat, never touch other chats, and are written back to `config.jsonc`, so they survive a restart. Anonymous identities cannot use the self-service ones. Administrators can edit `ignored_user_ids` directly, and the change applies immediately.

## Active hours and the attention window

By default a listed group chat opens a message batch for any triggerable message. With active hours configured, only messages that address the bot directly can open one outside the schedule; a hit then opens an attention window, and messages inside it are treated as if the schedule were active.

```jsonc
{
  "telegram": {
    "participation": {
      "active_windows": [
        { "start": "09:00", "end": "12:00" },
        { "start": "20:00", "end": "01:00", "days": [5, 6, 7] }
      ],
      "trigger_keywords": ["surowan", "wan"],
      "attention_window_seconds": 300
    }
  }
}
```

- Windows are read in the chat's timezone; `days` uses ISO weekdays 1–7 and means every day when omitted.
- An end time earlier than the start crosses midnight, and `24:00` means the end of the day. A window whose start and end are equal is rejected by `check-config`.
- Keywords match message text and captions, case-insensitively. Rich text (titles, lists, tables, images, as forwarded by other bots) matches the words that are visible; link targets and file names do not count.
- The two levels merge differently: `active_windows` is **replaced wholesale** (a chat's own list wins, and an empty array means no schedule at all), while `trigger_keywords` is **appended** to the global list (`[]` adds nothing).
- The attention window is timed per Chat + Topic, and its length comes from `attention_window_seconds`, 300 seconds by default.

Outside the schedule only four kinds of message open or refresh the window: `/ask`, a direct mention, a reply to one of the bot's own messages, and a trigger keyword. No attention window is opened during active hours, so the schedule ends exactly on time instead of lingering for one more window.

*Edit active hours* in the panel offers four modes: *No schedule restriction* (drop this chat's periods), *Custom periods* (per weekday and time), *No active periods* (ordinary messages never wake the bot; mentions, replies and keywords do), and *Only /ask*. The dialog also tells you which keywords and attention window are kept.

![A chat's active-hours dialog including the "Only /ask" option](__DOCS_BASE__/screenshots/chats/active-hours-ask-only.en.light.png)

## `/ask`-only mode

With `telegram.participation.ask_only` or the per-chat field set to `true`, only `/ask` can wake the bot: ordinary messages, mentions, replies, keywords, stickers and other bots' messages all fail to open a batch.

- It is off by default. The chat value overrides the global one, and an explicit `false` opts a chat out of a global on.
- In this mode `/ask` is handled at once without waiting to collect a batch, takes no other bots' messages along, and leaves no attention window.
- Messages are still stored and are visible as history on the next wake-up, and group memory keeps consolidating them. Active hours, keywords and the attention window are inert here, so there is no need to delete them.
- Private chats are unaffected: every message there is addressed to the bot anyway.

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1009876543210,
        "participation": { "ask_only": true }
      }
    ]
  }
}
```

It takes effect as soon as you save. A member sends `/ask <question>` and writes the whole question in one message; only that message enters the batch. Pause and sleep still apply, and the model still decides whether to answer.

## Proactive replies per chat

Proactive replies are a per-chat probability gate in front of ordinary group messages, off by default. A chat has three choices:

- **Follow the global setting**: delete this chat's override and inherit field by field.
- **Turn proactive replies off**: only messages addressed to the bot trigger it here.
- **Use custom values**: its own chance on the first try, increase per miss, and maximum consecutive tries (entered as percentages).

Only ordinary group messages are sampled; mentions, replies, keywords, `/ask` and commands are exempt. Counters are per chat, shared by its Forum Topics, and survive restarts. Private chats cannot configure proactive replies — `check-config` rejects it. The formula and how to verify it are in [Tune behaviour and cost](tuning.md).

![A chat's proactive reply chance dialog](__DOCS_BASE__/screenshots/chats/proactive-reply.en.light.png)

## Entry gate override per chat

The entry gate reads the global `telegram.decision_gate` by default. For a different judgement in one chat, open *More actions* → *Edit entry gate* and enable *Set … for this Chat* on the fields you want:

- Six fields can be overridden: enabled, mode, threshold, history messages, pending messages and the question text.
- Turning a switch off means "inherit the global value", and saving removes that field from the configuration; turning all six off and saving removes the whole override object.
- Connection settings (model, address, key, timeout) exist only globally — a chat cannot point the gate at another endpoint or credential.
- **A private chat cannot configure the gate**, and there is no menu entry for it: a private chat is a direct conversation, not a batch of group messages.

Saving applies immediately. The global section must already carry `api_key`, otherwise turning *enabled* on for the chat is rejected by `check-config`. Field meanings and the observe-then-enforce order are in [Tune behaviour and cost](tuning.md).

![A chat's entry gate override dialog with per-field switches](__DOCS_BASE__/screenshots/chats/entry-gate-override.en.light.png)

## MCP bindings and tool narrowing

By default every chat reaches every configured outbound MCP server, using the server's own settings. To narrow it, open *MCP servers* and pick:

- **Inherit every server**: no binding is written; behaves exactly like an unconfigured chat.
- **No MCP tools**: an empty binding; this chat can call nothing.
- **Explicit bindings**: choose servers and, per server, the subset of tools this chat may call.

A binding can only narrow. The selected tools must be tools the server already exposes; when the server allows all tools, its tool list is only known after it connects, so the panel can edit just the saved selection. Every explicit tool must resolve a policy (its own override, an entry on the server, or the server's default policy), otherwise `check-config` rejects it.

Bindings apply as soon as you save: narrowing stops the affected runs and resumes them, while adding a server or widening a tool list does not interrupt anything. Server-side fields, `exposure` and `skills` are documented in [External MCP settings](../configuration/mcp.md).

![A chat's MCP server binding dialog with explicit bindings and narrowed tools](__DOCS_BASE__/screenshots/chats/mcp-binding.en.light.png)

## Quick links

*More actions* → *Open related pages* carries the current chat as `?chat=<chat ID>` to another page, filtering that list to this chat: Prompts, Dictionary, Memories, Group memory, Messages, Tool sessions and Alarms. When something goes wrong in one group, starting from Tool sessions is usually fastest.

## Removing a chat is not the same as deleting its data

Both stop the bot from handling the chat, but the data story is completely different:

- **Removing it from the configuration** (hand edit or a file write through the API) needs no restart once the configuration is applied. After the chat disappears from the configuration its runs are stopped and new messages are refused, but stored messages, contexts, memory entries, images and audit **all stay**. Add it back and everything is as it was.
- **Removing it in the panel** (*Remove* → *Remove Chat*) first removes it from the configuration, then stops and waits for its running invocations to settle, and then deletes its memory entries, images and stored messages. That cannot be undone.

The panel delete also has two explicit "not deleted" answers, both of which keep the data:

- `chat_delete_pending`: the configuration is updated but work is still stopping. Reload and delete again.
- `chat_still_authorized`: this group changed its ID at some point (for example when it became a supergroup) and its other ID is still configured, so the bot may still be serving it and the data was retained.

## Confirm a change took effect

- The *Status* column on **Chats** says *Active*, *Changes pending*, *Addition pending* or *Removal pending* per chat.
- Changes that need a restart (the topic scope, for instance) show a banner at the top of the page with *N settings are waiting for a restart* and *Restart now*; a deployment that cannot restart from the panel says so instead. What needs a restart and what does not is in [Configuration lifecycle](../configuration/lifecycle.md).
- For details, check what is actually running: `/status` shows the model in effect for the chat, `/effort` shows the effort levels the current model accepts and the level this chat overrides, and *Model calls* on an invocation shows the provider, model and effort that run actually used.
