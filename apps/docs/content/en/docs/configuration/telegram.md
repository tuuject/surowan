---
title: Telegram settings
description: What the optional telegram section means — token, batch timing, Chats and Topics, participation, proactive replies, the entry gate, group memory, per-Chat MCP bindings and sticker sets.
---

# Telegram settings

`telegram` is optional. Omitting the section, or writing it without a `token`, means Telegram is disabled: the process still starts, the Admin Panel and the [Playground](../guides/playground.md) work, and simply no bot is connected. Field types, limits and defaults are in the [`telegram` field reference](fields-telegram.md).

This page explains cross-field constraints and semantics. The task of connecting a bot is in [your first bot](../guides/first-bot.md); tuning batches and participation is in [tune behaviour and cost](../guides/tuning.md); per-chat rules are in [set boundaries per chat and topic](../guides/chats.md).

## Token and connection state

`token` is a SecretRef; a string is rejected. Three states are distinct:

- **Disabled**: no `token`, or a reference that resolves to an empty string (for example an environment variable set to nothing).
- **Configuration error**: the reference cannot produce a value (unset variable, missing keychain entry, failing command). The process keeps running and the panel stays available, but the connection state is `config_error` with reason `token_unreadable`. Fix the reference and press **Apply config file**; no restart is needed.
- **Configured**: the connection manager has a token it can use.

`token` is a hot field: rotating the keychain entry or switching to another SecretRef makes the connection manager follow it on the next apply.

## Batch timing

The bot does not answer message by message. A message that can open a batch starts a short collection window, and the whole batch is handed to the model when it closes. All three fields are integer seconds in 0–300:

- `bucket_window_seconds` (required; the default `15` only applies when the whole section is absent): the batch collects at least this long.
- `bucket_bump_seconds` (optional, runtime default `0`): every new message that can open a batch pushes the deadline to at least "its arrival + this value".
- `bucket_max_seconds` (optional, defaults to **`bucket_window_seconds`**): the ceiling measured from the batch's first message; extension never passes it.

Only messages that can trigger the bot extend the wait. Other bots' messages, join/leave service messages and a lone sticker (unless `sticker_trigger_enabled` is on) are collected into the batch without postponing it.

Cross-field rules (enforced by `check-config`):

- `bucket_max_seconds` may not be smaller than `bucket_window_seconds`.
- With long-lived invocations on (`agent.context.idle_grace_seconds > 0`), the grace may not be smaller than `bucket_max_seconds`. A grace of `0` turns long-lived invocations off; see [agent settings](agent.md).

All three are hot, but only for batches opened afterwards: a batch already collecting finishes with the timing it started with. A configuration that omits the two adaptive fields keeps a fixed window, because `max` follows the window rather than the constant 15.

## Chat and Topic ranges

`chats` is the only allowlist; `{ "id": … }` alone admits a chat:

```jsonc
{
  "telegram": {
    "chats": [
      { "id": 123456789 },
      { "id": -1001234567890, "topic_ids": [100, 200] }
    ]
  }
}
```

- Chat IDs must be non-zero safe integers and unique: private chats are positive, groups and supergroups negative.
- Without `topic_ids` the chat's ordinary messages and all its Topics are allowed; with it, only the listed positive Topic IDs are. A Forum Topic keeps its own Conversation and Context, while the Memo Pad and Chat-level settings are shared by all Topics.
- `timezone` overrides the default timezone and is what participation windows are resolved in. It is a restart field.
- `instructions_file` points at the chat's extra prompt, layered on top of the global persona; the path resolves against the configuration's directory. Editing the path or the content is hot, and rebuilds that Conversation's Context on its next run.
- `provider` / `model` / `thinking_level` are the per-Chat model override; `provider` and `model` must be written together, and a Topic follows its chat.
- `ignored_user_ids` is this chat's ignore list: those members' new messages and edits only keep their update audit rows and never reach messages or Context. In live messages, `/ask`, `/help`, `/ignoreme` and `/unignoreme` still get through. The list is hot and does not rewrite existing data.

Adding or removing a chat is hot: removal immediately rejects that chat's updates and stops its running invocations, but **does not delete** stored data (the panel/API delete does). Topic ranges and a chat's `timezone` need a restart.

## Administrators

`admins` is the array of Telegram user IDs and the single source of truth for bot administrators: only those members can use `/pause`, `/resume`, `/model`, `/effort`, `/cut_topic`, `/rebuild_context` and `/allowlist`. The list is hot, so the next command uses it. Members can get their numeric ID with `/whoami`. The panel's Bot admins page edits this list.

## Participation

`telegram.participation` and `telegram.chats[].participation` narrow "any message that can trigger opens a session" into "active only during scheduled hours":

- `active_windows`: local wall-clock windows repeated daily, `HH:MM` to `HH:MM` (the end may be `24:00`); `days` holds ISO weekdays 1–7 and means every day when omitted. A window whose start equals its end is rejected.
- `trigger_keywords`: a message whose text or caption contains one of them counts as a trigger, case-insensitively.
- `attention_window_seconds`: how long a chat stays active after one trigger outside the windows; runtime default `300`.
- `ask_only`: when `true`, only `/ask` can open a batch; ordinary messages are still stored and still feed group memory, and a new batch is zero-second with no attention window.

Inheritance: a chat that writes `active_windows` replaces the global list wholesale, `trigger_keywords` are appended to the global list, and the window length overrides the global one. Private chats are unaffected; configuring `participation` on a positive Chat ID is rejected by `check-config`.

## Proactive replies

`telegram.proactive_reply` plus per-Chat overrides decide how often an ordinary group message actually wakes the bot. Off by default; when on, every due batch passes one probability sample:

- `base_probability` (runtime default `0.2`), `increment` (default `0.1`) and `hard_pity` (default `8`): the chance at attempt `n` is `min(1, base + (n - 1) × increment)`, and `hard_pity` always hits.
- A chat inherits the global section field by field and cannot be private.
- Direct triggers (@, a reply to the bot, a keyword, a bot command, `/ask`) bypass sampling entirely and leave the pity counter alone.
- When a chat's entry gate is in `enforce`, that chat stops sampling altogether — a batch sampled in and then dropped by the gate would burn the pity counter for nothing.

A batch that loses the sample is closed as `skipped_budget` with reason `proactive_reply_skipped`; no message is deleted.

## Entry gate

`telegram.decision_gate` asks a small decision model whether a batch is worth answering before the main model sees it. It is a cost and spam filter, not moderation.

Connection settings live on the global section only; behaviour settings may be overridden per chat:

- Global: `enabled`, `mode`, `threshold`, `history_messages`, `pending_messages`, `instructions`, `model`, `base_url`, `api_key`, `timeout_ms`.
- Per chat (`chats[].decision_gate`): only `enabled`, `mode`, `threshold`, `history_messages`, `pending_messages` and `instructions`, each inherited from the global section.

Constraints and behaviour:

- `mode` is `shadow` (record only, never change scheduling, the default) or `enforce` (a rejected batch is closed as `skipped_budget`/`decision_gate_dropped` and no invocation starts).
- `enabled: true` requires an `api_key`, otherwise `check-config` rejects the file — whether the global section or a single chat turns it on.
- `base_url` must be an HTTPS prefix with no credentials, query or fragment, because the client only appends `/decisions` to it.
- `threshold` (runtime default `0.57`), `model` (default `typesafe/jev-1.14`) and `instructions` belong together: changing the model or the question invalidates the old threshold, so observe the gate in `shadow` again first.
- `timeout_ms` (default `3000`) is the budget shared by credential resolution and the HTTP request. Timeouts, network errors and unresolvable credentials all **admit** the batch and record the reason; unresolved credentials are covered in [secrets and paths](secrets.md).
- A private chat cannot configure `decision_gate` at all. Playground rooms, catch-up batches, task receipts, recurring alarms, panel resumes and direct triggers (@, reply to the bot, keyword, `/ask`) never pass through the gate.

`decision_gate` and its per-Chat overrides are hot: every decision re-reads the published settings and the credential reference.

## Group memory

`telegram.chats[].group_memory` enables recall per chat; there is no global default:

- `enabled` is required.
- `idle_minutes` (runtime default `30`): after the chat stays quiet this long, the background worker hands the still-unprocessed messages of a local day to the **system tool model**, which writes dated event summaries with message-id ranges. A day that has already ended does not have to wait for idleness.
- `thirty_hour_clock`: `off` (the default), `non_overlapping` or `overlapping`. It only changes which local span a dated search covers: `off` is 00:00–24:00 of the date, `non_overlapping` is 06:00 to 06:00 the next day, `overlapping` is 00:00 to 06:00 the next day. Consolidation and archiving still follow the calendar day.

Which model consolidates is decided by `tool_model` (which inherits the global agent when omitted); see [tool model settings](tool-model.md). Toggling the feature stops that chat's running invocations and rebuilds their Context; turning it off only stops further consolidation, and existing memories and original messages are kept.

## Per-Chat MCP bindings

`telegram.chats[].mcp` narrows which external tools a chat may use; it never copies connection settings (the server itself is written in `mcp.servers`, covered in [external MCP settings](mcp.md)):

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "tools",
        "transport": "stdio",
        "command": ["example-mcp-server"],
        "tools": ["search_docs"],
        "payload_max_bytes": 4096,
        "result_max_bytes": 4096,
        "tool_policies": [{ "name": "search_docs", "read_only": true, "timeout_seconds": 10 }]
      }
    ]
  },
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "mcp": [{ "server": "tools", "tools": ["search_docs"] }]
      }
    ]
  }
}
```

- `server` must be an alias already declared under `mcp.servers`, and a chat cannot bind the same alias twice.
- Omitting `tools`, or writing `"*"`, means whatever the server declares; an explicit list must name tools that server exposes (checked during configuration validation for explicit server lists, and at discovery time for a `"*"` server).
- Every selected tool must resolve a policy: the binding's own `tool_policies`, the server's `tool_policies`, or the server's `default_tool_policy`.
- Bindings are hot: narrowing (one tool less, a server gone or changed) stops that chat, rebuilds its Context and resumes; widening alone does not interrupt a run.

## Sticker sets

`telegram.sticker_sets` is the list of sets the bot may send stickers from; the panel's Bot sticker sets page edits it:

```jsonc
{
  "telegram": {
    "sticker_sets": [
      { "alias": "cats", "name": "TelegramStickerSetName", "note": "Use when teasing; avoid in serious threads" }
    ]
  }
}
```

- `name` is the Telegram set name and the set's identity: compared case-insensitively and required to be unique. Once added it cannot be repointed; switching sets means deleting and adding.
- `alias` is a nickname, unique among the configured sets, and the model sees it in the sticker catalog.
- `note` (optional, 1–500 characters) is operator guidance shown to the model with the catalog.
- The whole list is hot: adding or removing a set immediately aborts every running Telegram invocation so the next reply sees the new list; editing only `alias` or `note` does not abort anything.
- Visual sticker indexing needs a vision model; see [vision settings](vision.md).

## Other switches

- `process_bot_messages` (required): whether other bots' messages are processed. With `false` they only keep update audit rows; with `true` they are stored but can never open a batch, so two bots cannot wake each other. Restart field.
- `sticker_trigger_enabled` (optional, default `false`): whether a lone sticker can open a batch. Restart field.
- `mention_typing_enabled` (optional, default `true`): show "typing" immediately when the bot is mentioned and the message enters a batch. Restart field.

## How changes take effect

`token`, the three batch timing fields, `admins`, `sticker_sets`, adding or removing a chat, per-Chat model overrides, `instructions_file`, `ignored_user_ids`, `participation`, `proactive_reply`, `decision_gate`, `group_memory`, `mcp` and `dictionary_injection_mode` are hot; `topic_ids`, `timezone`, `process_bot_messages`, `sticker_trigger_enabled` and `mention_typing_enabled` need a restart. The full matrix and failure handling are in [configuration lifecycle](lifecycle.md).
