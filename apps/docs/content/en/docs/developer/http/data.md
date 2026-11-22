---
title: Knowledge and alarm data API
description: Memo Pad entries and blobs, the dictionary with its import and merge flow, group-memory events, one-time alarms and recurring alarms.
---

# Knowledge and alarm data API

These routes read and write the rows the bot keeps for itself: memory entries, the dictionary, consolidated group-memory events, one-time alarms and the admin-defined recurring alarms. None of them edits `config.jsonc`, so none takes the configuration revision — the revisioned rows carry their own.

The exhaustive list is in the [data endpoint catalog](endpoints-data.md).

## Memo Pad

A memo belongs to one Chat (all of its Topics share it) and has a short summary plus a Markdown detail. Memo ids look like `mem_<32 hex>`, not decimals.

| Route | Request |
| --- | --- |
| `GET /api/memories?chat=&state=&limit=&offset=&as_of=` | — |
| `GET /api/memories/chats` | — |
| `POST /api/memories` | `{chat_id, summary, detail, ttl_seconds?}` |
| `PUT /api/memories/:id` | `{summary?, detail?, ttl_seconds?}` |
| `DELETE /api/memories/:id` | — |
| `GET /api/memories/blobs/:id/content` | — (bytes) |

- `chat_id` is the Telegram chat id; a Chat the bot has never seen answers `404 chat_not_found`.
- `summary` is 1–150 characters, `detail` 1–32 768. The body limit on these two routes is 256 KiB, because escaping can inflate a full detail.
- `ttl_seconds` is 60–157 680 000 (five years) or `null`. Omitting it creates a permanent entry; sending `null` on update turns an expiring entry into a permanent one.
- `state` filters the listing: `active`, `expired`, `short` (expiring, still valid) or `long` (permanent) — anything else is `400 invalid_state`.
- Each item reports `expires_at`, `remaining_seconds`, `expired` and `short_term`, so a client never recomputes expiry from the clock it happens to have.
- `PUT` needs at least one of the three fields. A detail edit also cleans up blobs the old text referenced, and `DELETE` removes the memo plus the blobs only it referenced.
- `GET /api/memories/blobs/:id/content` serves the image bytes with `content-disposition: inline` and `cache-control: private, no-store`. A blob id is `blb_…`; anything else is `400 invalid_id`, a missing file `404`.

Blobs are uploaded by the agent inside a conversation, not through this API; these routes only read and clean them. The panel and the guide for [memory](../../guides/knowledge.md) cover the workflow.

## Group memory

Group memory is generated, not authored: the sleeping job consolidates a quiet Chat into events that each carry a Telegram message-id range. Only the summary is editable here.

| Route | Request |
| --- | --- |
| `GET /api/group-memories?chat=&day=&search=&limit=&offset=&as_of=` | — |
| `GET /api/group-memories/progress` | — |
| `GET /api/group-memories/runs?chat=&state=&limit=&offset=&as_of=` | — |
| `GET /api/group-memories/:id/messages` | — |
| `PUT /api/group-memories/:id` | `{summary}` |
| `DELETE /api/group-memories/:id` | — |

- An event id is `gmem_<32 hex>`; `day` is a Chat-local `YYYY-MM-DD` and is validated as one.
- `summary` is 1–200 characters and is trimmed; a blank one is `400 invalid_body`.
- `GET …/:id/messages` replays the event's stored source range through the current message rows and truncates the text at the read limit, appending a marker — the same bound the bot's `read_group_messages` uses.
- `progress` is the operational view: per-Chat lanes, backlog, backoff and recent failures. `runs` lists the consolidation batches with their outcome and failure reason.
- `DELETE` removes the event but does **not** rewind the sleeping watermark, so the same messages are not consolidated again. Deleting an event is final in that sense.

The 30-hour clock (`thirty_hour_clock`) is a per-Chat setting and lives on the [configuration page](configuration.md#chats-and-participation); it changes how date lookups range over events, not the rows here.

## Dictionary

A dictionary entry belongs either to the global scope or to one Chat, and its `revision` is the optimistic lock for edits. Conflicts by term are reported, never blocked — a term may legitimately have several entries.

| Route | Request |
| --- | --- |
| `GET /api/dictionary?scope=&chat=&search=` | — |
| `GET /api/dictionary/chats` | — |
| `POST /api/dictionary` | a draft |
| `PUT /api/dictionary/:id` | a draft, `If-Match: <entry revision>` |
| `DELETE /api/dictionary/:id` | `If-Match: <entry revision>` |
| `GET /api/dictionary/settings?chat=` | — |
| `PUT /api/dictionary/settings?chat=` | `{injection_mode}` |
| `POST /api/dictionary/import/preview` | `{format, content, scope, chat_id}` |
| `POST /api/dictionary/import` | `{entries: [...]}` |
| `GET /api/dictionary/export?scope=&chat=&format=csv｜jsonl` | — |
| `POST /api/dictionary/merge/preview` | `{ids: [...]}` (billed) |
| `POST /api/dictionary/merge` | `{entry, sources, delete_sources}` |

A draft is `{term, definition, aliases: string[], scope: "global"｜"group", chat_id, enabled}`. A global entry must not name a chat, a group entry must; both rules answer `400 invalid_body`. A stale `If-Match` is `409 dictionary_conflict` — a dedicated code, because it is a row conflict rather than a configuration one.

- `GET /api/dictionary` returns entries plus the name conflicts of that scope. `scope` is required; `chat` is required for `group`.
- Settings: `injection_mode` is `off`, `on_demand` (the default) or `aggressive`; `null` clears a Chat override but cannot clear the global mode. The view reports `injection_mode` (global), `override_mode` (this Chat, or `null`) and `effective_mode`.
- Import is two-step. `preview` parses a CSV or JSONL document (at most 2 000 000 characters) and returns normalized drafts plus the conflicts it found *including the file's own rows*; `import` creates up to 2 000 entries in one transaction. Preview writes nothing, so repeating it is free.
- `export` answers a downloadable `text/csv` or `application/x-ndjson` body with a `content-disposition` filename.
- Merge is two-step as well. `merge/preview` takes 2–20 entry ids, calls the tool model once and returns a suggestion plus the source entries — billed, and nothing is saved. `merge` takes the final draft, the source ids with their revisions, and `delete_sources`; it is destructive because deleting the sources removes them for good.
- `PUT /api/tool-model` sets the auxiliary model for merges, group-memory consolidation, MCP description drafts and asset extraction: `{inherit: true}` follows the agent model, `{provider, model, thinking_level}` pins one.

## One-time alarms

`GET /api/alarms?state=&chat=&target=&limit=&offset=&as_of=` lists the Alarm projections of long-running tasks. `state` is `pending`, `firing`, `fired` or `cancelled` (`400 invalid_state` otherwise).

`DELETE /api/alarms/:id` cancels a pending alarm and answers `{status: "cancelled"}`. Only a pending alarm can be cancelled: anything else is `409 alarm_not_pending`, and an unknown id is `404 not_found`. Alarms are created by the bot inside a conversation, never through this API.

## Recurring alarms

A recurring alarm is admin-defined: a trusted prompt injected into one target on a schedule, with its own time zone and its own firing history. Creating, updating and running one lets the bot call its model with nobody present and past the daily budget, so those three routes require `write+paid`.

| Route | Request |
| --- | --- |
| `GET /api/recurring-alarms?chat=&enabled=&limit=&offset=&as_of=` | — |
| `GET /api/recurring-alarms/targets` | — |
| `POST /api/recurring-alarms/preview` | `{rules, time_zone}` |
| `POST /api/recurring-alarms` | `{chat_id, message_thread_id, title, prompt, rules, input_mode, time_zone, enabled}` |
| `GET /api/recurring-alarms/:id` | — |
| `PUT /api/recurring-alarms/:id` | the draft fields, `If-Match: <alarm revision>` |
| `DELETE /api/recurring-alarms/:id` | — |
| `POST /api/recurring-alarms/:id/run` | — |

- `rules` is an array of schedule rules; `input_mode` is `builder` or `cron` and describes how the rules were authored. `time_zone` is an IANA name, and an alarm keeps it even when the global zone changes.
- `preview` validates `{rules, time_zone}` without saving and returns `{next, issues, time_zone, short_interval}`: up to five upcoming occurrences as UTC timestamps, the per-rule issues, the canonical zone, and whether two occurrences are closer than five minutes. It needs only the read grant.
- `POST` refuses a target that is not a configured Chat, Topic or Playground room with `409 target_unavailable`, and a duplicate/limit refusal with `409 too_many_recurring_alarms`.
- `targets` lists what an alarm may point at and returns `default_time_zone`, the global zone a new alarm starts from.
- An invalid rule set is `400 invalid_rules` with an `issues` array; an invalid zone, title or prompt is `400` with its own code.
- `PUT` replaces the definition, including enabling or disabling it, and needs the row's own revision: a stale one is `409 revision_conflict`.
- `DELETE` removes the alarm and suppresses its undelivered occurrence.
- `run` fires the saved alarm once, outside its schedule, and answers `{firing_id, task_id, occurrence_at}`. The invocation it creates is a normal run, so it appears in the audit lists and can be resumed like one.

The firing history on the detail view carries the last 50 firings with their outcome, skip reason and the invocation they produced. A refusal to fire while the previous occurrence is still pending is `409 previous_pending`.
