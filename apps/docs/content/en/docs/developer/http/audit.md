---
title: Audit, resume and export API
description: Read runs, usage and warnings data, download media, resume a failed run for real, and know what an invocation query can filter on.
---

# Audit, resume and export API

These routes are how a program answers "what happened". They read the audit tables the runtime writes, and one of them — `POST /api/invocations/:id/resume` — starts a real run that may send Telegram messages and spend tokens.

The exhaustive route list is in the generated [audit endpoint catalog](endpoints-audit.md); this page documents what each route returns and what it refuses.

## Overview and usage

`GET /api/overview` is the panel's Overview page as JSON, without any filters:

```json
{
  "generated_at": "2026-11-20T09:12:44.501Z",
  "invocation_states": [{ "label": "completed", "count": 812 }],
  "sticker_index_states": [{ "label": "indexed", "count": 240 }],
  "top_tools": [{ "label": "send", "count": 904 }],
  "daily_usage": [{ "resource": "agent", "metric": "model_tokens", "scope": "global", "amount": 812300 }],
  "runtime_status": { "sleeping": false, "sleep_until": null, "paused_chats": [] },
  "message_count": 24011,
  "cached_analysis_count": 118
}
```

`generated_at` is the server clock, so a caller can tell a stale cache from a live one. `runtime_status.sleep_until` is only set while the bot is sleeping; `paused_chats` lists the Chats paused from the panel.

`GET /api/usage?days=N` returns one point per UTC day, including days with no activity:

```json
{
  "days": 3,
  "series": [
    { "date": "2026-11-18", "model_tokens": 0, "vision_tokens": 0, "tool_calls": 0, "agent_invocations": 0 },
    { "date": "2026-11-19", "model_tokens": 120334, "vision_tokens": 4021, "tool_calls": 63, "agent_invocations": 21 }
  ]
}
```

`days` defaults to 7 and must be an integer from 1 to 90; anything else is `400 invalid_days`. Token counts come from the recorded daily usage, while `tool_calls` and `agent_invocations` are counted from the audit tables — they can therefore disagree with a `daily_usage` row for the same day.

## Configuration, prompt and model views

Three read-only views let a tool compare what is running with what is on disk. All three take `?source=active|file`, default `active`, and reject any other parameter with `400 invalid_query`.

- `GET /api/config/view` — the redacted configuration. `active` describes the running process (`generation`, `active_hash`, `file_hash`, `restart_required`); `file` re-reads `config.jsonc` (`file_hash`, and `422 config_invalid` when the file cannot be loaded safely). Credentials, SecretRefs and command argv never appear.
- `GET /api/prompts/global` — the global persona template.
- `GET /api/prompts/group?chat=<id>` — one Chat's group prompt; `chat` is required and must be a configured or migrated Telegram chat id, otherwise `400 invalid_chat` / `404`.

`GET /api/models` lists the text models of the active configuration (`{source, generation, models}`) and takes no query parameters. `GET /api/key` returns the calling credential's identity (see the [HTTP conventions](index.md)). `GET /api/version` returns `{version, channel}` and also rejects any query parameter.

These views are reads. Editing them is on the [configuration page](configuration.md).

## Invocations

`GET /api/invocations` is the list. Every filter is optional and they combine:

| Parameter | Meaning |
| --- | --- |
| `state` | exact invocation state, e.g. `failed`, `completed`, `running` |
| `host` | `telegram` or `playground` |
| `chat` | the Telegram Chat id; a room's invocation has no Telegram id, so this filter excludes Playground rows |
| `model` | the exact model id an **agent** call used; vision and auxiliary calls never match |
| `search` | text that must appear in a message of the Conversation |
| `at` | one minute/second window, resolved in the Chat or global timezone |
| `from` / `to` | inclusive lower and exclusive upper time bounds, same grammar as `at` |
| `limit` `offset` `as_of` | [snapshot pagination](index.md#snapshot-pagination) |

`at` cannot be combined with `from` or `to` (`400 invalid_time_range`), and a message filter must match at least one message. Rows carry the counters the runtime recorded (`sends_used`, `tool_calls_used`, `turns_used`, `tool_call_count`), the token total under the daily-budget definition (`total_tokens`, with `cache_read_tokens` / `cache_write_tokens` as a breakdown), `total_cost` when the provider reported one, and the Chat identity block (`host_kind`, `telegram_chat_id`, `chat_type`, `message_thread_id`).

`GET /api/invocations/:id` returns the detail: model calls, tool calls, sends, the retained Context messages of that run (a new message carries `source_bucket_id`, the batch it arrived in), and `buckets`: every batch the run took with `injected_at`, when the model read it (`null` while it waits, or when the run ended first). It also returns the resume verdict, so a client can offer the button only when the click would succeed:

```json
{ "…": "…", "resume": { "available": true, "reason": null } }
```

When it is not available, `reason` is the error code a resume would answer with (`resume_not_latest`, `resume_conversation_busy`, …).

`GET /api/invocations/:id/prompts` shows the template text a replay would use today — deliberately not the text the recorded run used. `GET /api/invocations/:id/replay-preflight` answers whether a replay is possible, and accepts at most one each of `before_send_id`, `provider`, `model` and `thinking_level`; it calls no model.

## Media and exports

The Telegram bytes stay on the server; a caller can only name media the snapshot authorises.

- `GET /api/invocations/:id/media` lists the media of one run.
- `GET /api/invocations/:id/media/:media_id/content?variant=original|preview` returns the bytes, with `content-disposition: attachment`, `cache-control: private, no-store` and `x-plasticwan-media-variant`. `variant` defaults to `original`; anything but `original`/`preview` is `400 invalid_variant`. A snapshot whose authorization check no longer matches answers `409` instead of serving the file.
- `GET /api/invocations/:id/tools/:tool_call_id/images/:asset_id` and `GET /api/contexts/:conversation_id/messages/:seq/images/:asset_id` serve images a tool produced or a retained message carried.

There is no bulk audit export endpoint: reviews are exported by the panel from browser-local data, and everything else is these reads plus whatever your own script writes. `dictionary/export` on the [data page](data.md) is the one server-side text export.

## Messages, Contexts and stickers

`GET /api/messages?chat=&search=&limit=&offset=&as_of=` lists stored Telegram messages (newest first, snapshot paged). `GET /api/messages/:id` returns one message with **every revision** and its media, including the edit history and the sender as recorded at that revision. It is the only audit surface that keeps pre-edit text; every other view resolves the latest revision.

`GET /api/contexts?chat=` lists Conversation Contexts, one row per conversation, with the retained-message count and the active pointer; `GET /api/contexts/:id` returns the retained messages and the references the model may still read. A Context is not a transcript of the Chat: it is the canonical history the agent sees, trimmed by the GC rules the [guides](../../guides/tuning.md) explain.

`GET /api/stickers?set=&state=&search=` lists the sticker vision index (the `set` parameter takes the configured alias).

## Resume a failed run

`POST /api/invocations/:id/resume` starts a **real** run of the latest failed invocation's conversation, with the configuration that is active now. It needs `write+paid`: it can send Telegram messages and it spends tokens.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/invocations/912/resume \
  -H "Authorization: Bearer $SUROWAN_API_KEY"
```

```http
202 Accepted

{
  "invocation_id": "913",
  "bucket_id": "1402",
  "resumed_from_invocation_id": "912"
}
```

The response body is the *new* invocation; the resumed-from id lets a client follow the chain. Refusals are explicit:

| Code | Status | Meaning |
| --- | --- | --- |
| `not_found` | 404 | no invocation with that id |
| `resume_not_failed` | 409 | only `failed`, `aborted` or an unknown-outcome run can be resumed |
| `resume_not_latest` | 409 | a later invocation exists in the same conversation |
| `resume_conversation_busy` | 409 | the conversation already has a queued or running invocation |
| `resume_unsupported_host` | 409 | Playground runs retry through their Release instead |
| `resume_host_unavailable` | 409 | Telegram is disabled or not connected |
| `resume_sleeping` | 409 | the bot is sleeping for its daily budget |
| `resume_chat_removed`, `resume_topic_removed` | 409 | the Chat or Topic is no longer allowed |
| `resume_chat_paused` | 409 | the Chat is paused |
| `resume_agent_unconfigured` | 409 | the Chat has no complete agent model |

A resume carries no body and ignores any it receives. Because the run happens asynchronously, poll the returned `invocation_id` (or the live stream) to see how it ended; the resume itself is logged as an admin action.

Replay is the sibling operation with different guarantees: `POST /api/invocations/:id/replay` re-runs a recorded invocation with editable templates and model overrides, is billed, and deliberately does not send. It needs the `paid` grant and its body accepts only `before_send_id`, `provider` + `model` together, `thinking_level`, and the two prompt templates (at most 65 536 characters each); anything else is `400 invalid_body`. Use [Invocation preflight and replay](../replay.md) to understand the fidelity limits.

## Runtime controls on this page

- `POST /api/cancel-ongoing-sessions` aborts every running and queued invocation, expires their buckets, and answers `{canceled_buckets, canceled_invocations}` (running invocations are included in the second count). It is destructive: the batches those runs were answering get no reply.
- `POST /api/wake` clears the persisted sleep state and wakes the scheduler; `was_sleeping` tells you whether it did anything.
- `POST /api/restart` answers `202 {status: "restarting"}` and exits with the restart code. It only exists when the deployment declares a supervisor (`PLASTICWAN_SUPERVISED=1`); otherwise `409 restart_unsupported`.
