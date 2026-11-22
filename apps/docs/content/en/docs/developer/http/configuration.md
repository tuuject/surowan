---
title: Configuration, gate and tool API
description: The routes that write config.jsonc — providers and models, prompts, chats, the entry gate, harness tuning, search, Telegram, sticker sets and outbound MCP servers — with their conflicts and their apply results.
---

# Configuration, gate and tool API

Every route on this page edits `config.jsonc`. They share three rules, stated once here and then assumed:

1. The request carries `If-Match` with the configuration revision from `GET /api/providers`; a missing header is `400 revision_required`, a stale one `409 config_conflict`.
2. The write is validated against the file's own schema and semantics *before* it lands, so a range or an enum the file would reject answers `400` here instead of producing an unloadable file.
3. The response is the same view the panel reads, plus `apply: {applied, restart_required, outside_serve}`. See [saved but not applied](index.md#saved-but-not-applied) for what that means.

Plaintext secrets in a body become Keychain entries; a `{ "entry": "name" }` object reuses an existing one and only a panel session may reference an entry. The exhaustive route list is in the [configuration endpoint catalog](endpoints-configuration.md).

## Providers and models

`GET /api/providers` is the anchor for everything else on this page, because it carries `revision`:

```json
{
  "revision": "0d6f2d…",
  "supervised": true,
  "agent": { "provider": "openrouter", "model": "…", "thinking_level": "medium" },
  "vision": { "provider": null, "model": null, "thinking_level": null },
  "tool_model": { "provider": null, "model": null, "thinking_level": null, "inherited": true },
  "restart_required": [],
  "providers": [
    {
      "alias": "openrouter",
      "kind": "custom",
      "api": "openai-completions",
      "base_url": "https://openrouter.ai/api/v1",
      "header_names": [],
      "models": [{ "id": "…", "name": "…" }]
    }
  ]
}
```

Null fields in `agent` mean no invocation can start. A panel session also sees each provider's `api_key_source` and `header_sources`; a key or paired client never does.

| Route | Body | Notes |
| --- | --- | --- |
| `POST /api/providers` | `{alias, kind: "builtin"｜"custom", provider?, base_url?, api?, api_key, headers?, models: [...]}` | a `builtin` provider needs `provider`; a `custom` one needs `base_url` and `api`; 1–200 models; body up to 512 KiB |
| `PUT /api/providers/:alias` | `{base_url?, api?, api_key?, headers?}` | a header set to `null` is deleted, an omitted one keeps its value; a `builtin` provider only accepts a new `api_key` (`400 immutable_field` otherwise) |
| `DELETE /api/providers/:alias` | — | `409 provider_in_use` while the agent, vision or any Chat still names it |
| `POST /api/providers/:alias/models` | `{models: [...]}` | append model definitions |
| `PUT /api/providers/:alias/models/:id` | one model definition | the id must be percent-encoded |
| `POST /api/providers/models/delete` | `{models: [{provider, model}]}` | several providers in one write |
| `DELETE /api/providers/:alias/models/:id` | — | refused while referenced |
| `PUT /api/model` | `{provider, model, abort_running?}` | the global agent model |
| `PUT /api/vision` | `{provider, model, thinking_level?}` | the independent image-analysis model |
| `PUT /api/thinking-level` | `{thinking_level}` | keeps per-Chat overrides |
| `GET /api/provider-presets` | — | the builtin provider catalog the panel can add |

`api` is one of `openai-responses`, `openai-completions`, `anthropic-messages`, `google-generative-ai`. A `custom` provider may move `base_url`, but a key or paired client must resend the API key and every header value in the same request (`400 credentials_required`); otherwise an injected prompt could point a configured credential at its own server. A panel session may move it without resending. A secret field accepts a plaintext string, `{ value, name? }` or `{ entry }`; a plaintext is registered in the Keychain before anything can echo it, so a rejected write never prints it.

Changing the agent model while runs still use the old one is refused instead of silently breaking them:

```json
{
  "error": "model_in_use",
  "message": "3 running invocation(s) still use the current model; send abort_running: true to stop them and switch",
  "running_invocations": 3
}
```

Resend the same request with `abort_running: true` to stop them — those batches get no reply — and the response reports `aborted_invocations` as well as the new `revision`. `PUT /api/chats/:id` with a new model enforces the same rule for one Chat.

Discovery and metadata are read-shaped POSTs that write nothing, so they take no revision:

- `POST /api/providers/discover` — `{alias}` for the saved connection or `{kind, provider?, base_url?, api?, api_key?, headers?}` for a temporary one. A temporary connection only accepts plaintext, never a Keychain entry: there would be nothing to reuse and an entry reference would let a caller probe a stored secret against an arbitrary address. The answer is `{endpoint, models: [{…metadata, configured}], metadata_source_error}`; a failed metadata fetch is reported, not fatal.
- `POST /api/providers/lookup-metadata` — `{kind, provider?, base_url?, api?, ids: [...]}` (1–100 ids) for manually entered model ids.
- `POST /api/providers/health-check` — `{provider, model}`, billed. It sends one real prompt and returns `{status, response_text, duration_ms, ttfb_ms, error}`. Refusals: `404 model_not_found`, `409 connection_not_applied`, `409 model_not_applied`, `409 model_not_registered`, `422 not_text_capable`, `429 health_check_busy` (three checks at a time).

## Prompts

The prompt manager is versioned: every save records a version, and the concurrency token is the prompt's own content hash — not the config revision.

| Route | Body | Notes |
| --- | --- | --- |
| `GET /api/prompts/versions?scope=global｜group&chat=` | — | retained versions, newest first; `chat` is required for `group` |
| `GET /api/prompts/versions/:id` | — | one version including its content |
| `GET /api/prompts/diff?from=&to=` | — | unified diff between two versions of the same scope |
| `PUT /api/prompts/global` | `{prompt, note?}` | at most 65 536 characters; `If-Match` is the current hash |
| `PUT /api/prompts/group?chat=<id>` | `{prompt, note?}` | creates the file at `prompts/chat-<id>.md` when the Chat has none |
| `POST /api/prompts/versions/:id/restore` | `{note?}` | restores as a new rollback version |
| `POST /api/prompts/cancel-running` | `{scope, chat_id?}` | cancels only the runs still on the previous prompt |

A save answers `{status: "saved"｜"unchanged", version, applied, restart_required, affected_running, context_rebuild: true, active_hash, file_hash}`. `affected_running` counts invocations still running under the old prompt; cancel them explicitly. `context_rebuild` is a promise, not a statistic: a changed stable prompt rebuilds the affected Conversation Contexts on their next run.

Refusals worth handling: `409 prompt_conflict` (someone else saved first), `400 prompt_empty` (a group prompt would be created empty), `409 prompt_file_exists` (the conventional path is taken by a file the configuration does not reference).

## Chats and participation

`GET /api/chats` returns `{revision, items, defaults, models, global_participation, global_proactive_reply, effective_global_proactive_reply, timezone, restart_required, supervised}`: the configured Chats with their saved and active settings, the global defaults, and the text models a Chat may select. Every write below is hot-applied and answers that same view plus `aborted_invocations` and `apply`.

| Route | Body |
| --- | --- |
| `POST /api/chats` | `{id, topic_ids, provider, model, thinking_level}` |
| `PUT /api/chats/:id` | same fields plus `abort_running?` |
| `DELETE /api/chats/:id` | — |
| `PUT /api/chats/:id/participation` | `{active_windows?, ask_only?}` |
| `PUT /api/chats/:id/decision-gate` | the six gate behavior fields |
| `PUT /api/chats/:id/proactive-reply` | `{mode: "inherit"｜"off"}` or `{mode: "custom", base_probability, increment, hard_pity}` |
| `PUT /api/chats/:id/mcp` | `{mode: "inherit"｜"none"}` or `{mode: "explicit", bindings: [{server, tools?, tool_policies?}]}` |
| `PUT /api/chats/:id/group-memory` | `{enabled, idle_minutes?, thirty_hour_clock?}` |

Details that the field names do not show:

- `id` is a string and must be a nonzero safe integer; `topic_ids` is an array of positive ids or `null` (all topics).
- `provider` / `model` are either both set or both `null` (inherit); a Chat model override must also set `thinking_level`, because an inherited level would tie the global default to this Chat's model.
- `DELETE` is two operations in one: remove the Chat from the allowlist, then delete its stored data. When a migration alias still authorises the Chat the answer is `409 chat_still_authorized` and the data is kept; while the Chat's work is still stopping it is `409 chat_delete_pending` and the data is kept. Reload and repeat the delete to finish.
- `participation.active_windows` is a whole replacement: `null` removes the override (inherit the global schedule), `[]` makes the Chat trigger-only. A window is `{start, end, days?}` with `HH:MM` (`end` also accepts `24:00`) and `days` as ISO weekdays 1–7. An empty window is refused, and a private Chat cannot configure participation at all.
- `ask_only: true` restricts the Chat to `/ask`: new batches are zero-length and leave no attention window. `null` removes the override.
- `decision-gate` accepts only `enabled`, `mode`, `threshold`, `history_messages`, `pending_messages` and `instructions`; `null` removes one, and removing all of them inherits the global section. `api_key`, `model`, `base_url` and `timeout_ms` are global only, and a private Chat cannot configure the gate.
- `proactive-reply` with `mode: "custom"` requires all three numbers: `base_probability` and `increment` in 0–1, `hard_pity` an integer 1–100.
- `mcp` with `mode: "explicit"` needs at least one binding and at most 64. The whole candidate file is validated, so an unknown alias or a tool the server does not expose is answered here with the configuration's own rule instead of by a failed apply.
- `group-memory` takes `enabled`, an optional `idle_minutes` (1–1440, `null` removes) and an optional `thirty_hour_clock` of `off`, `non_overlapping` or `overlapping`.

## Entry gate (Decisions)

`GET /api/decision-gate` reports both sides, the same way the Harness page does:

```json
{
  "revision": "…",
  "saved": { "enabled": false, "mode": "shadow", "threshold": 0.57, "history_messages": 10, "pending_messages": 10, "instructions": "…", "model": "typesafe/jev-1.14", "base_url": "https://openrouter.ai/api/alpha", "timeout_ms": 3000 },
  "active": { "…": "…" },
  "key_configured": true
}
```

Every field is reported with its default filled in, so a caller never has to know the defaults. `key_source` is added for a panel session only; the credential itself never travels.

`PUT /api/decision-gate` patches the section: omitted fields are kept, a `null` removes one from the file, and `api_key` accepts the shared secret input or `null`. Ranges come from the configuration schema (`threshold` 0–1, `history_messages` 0–50, `pending_messages` 1–50, `timeout_ms` 500–10 000); an unknown key is refused rather than ignored, which is what keeps a typo from silently doing nothing. A new key is written to the Keychain in the same lock hold as the file edit.

`GET /api/decision-gate/decisions?chat=&limit=&offset=&as_of=` is the audit list `shadow` mode is reviewed through. It is read-only and needs no write grant.

## Harness tuning and debug recording

`GET /api/harness` returns `{revision, saved, active}` for the editable `agent` fields and the global proactive-reply defaults; `PUT /api/harness` takes `{values: {"<field>": value}}`. The field keys are dotted paths below their section, for example `daily_budget.max_tokens`, `max_concurrency`, `context_stop_ratio`, `history_messages`, `send_max_text_length`, `send_nudge_enabled`, `send_barrier_enabled`, `send_duplicate_guard_enabled`, `send_empty_text_strategy`, `send_empty_text_fallback_texts`, `context.retained_sends_target`, `context.hard_token_ratio`, `context.ref_ttl_hours`, `context.idle_grace_seconds`, `context.max_wall_clock_seconds`, `context.agent_cache_size`, `rate_limits.sends_per_window`, `rate_limits.window_seconds`, `rate_limits.turns_per_injection`, and the four `proactive_reply.*` fields. `GET /api/harness` lists every editable key in `saved`, so read that field instead of hardcoding a list. An unknown key is `400 invalid_body`; a `null` removes an optional field, and the response reports the value the runtime resolves instead.

`GET /api/developer` shows the debug recording switches and the model metadata catalog address; `PUT /api/developer` saves `record_model_payloads`, `record_agent_thinking` and `models_dev_url` (a URL string or `null`, which falls back to models.dev). `DELETE /api/developer/model-payloads` clears stored request and response payloads in batches — destructive, and it reports how many rows it cleared.

## Web search

`GET /api/search/config` returns `{revision, enabled, active, url_filters, engines, providers}`. Each engine carries `id`, `provider`, `enabled`, `endpoint`, `results`, `timeout_seconds`, `note` and `key_configured`; a session also sees `key_source`. `providers` is what the loaded plugins actually registered, so the panel never invents one.

`PUT /api/search/config` replaces the whole section with `{enabled, engines: [...], url_filters: [...]}`:

- at most 32 engines, each an object with `id` (lowercase letters, digits and dashes, up to 32 characters), `provider`, and optional `enabled`, `endpoint`, `results` (1–10, only when the provider reports a result count), `timeout_seconds` (5–30), `note`, `api_key` and `keep_api_key`;
- `keep_api_key: true` keeps the stored credential, and sending a new `api_key` at the same time is refused;
- `url_filters` are RE2 patterns compiled by the server; an invalid one is a `400` with the rule's message.

`active` can be false while `enabled` is true: an enabled switch with no enabled engine is not an active one.

## Telegram and sticker sets

`GET /api/telegram` reports `{revision, status, telegram_section_present, token_configured, bucket_timing: {saved, active}}`. `status` is the live connection state, and `token_source` is added for a session — the token itself never comes back.

| Route | Body |
| --- | --- |
| `PUT /api/telegram/bucket-timing` | `{bucket_window_seconds?, bucket_max_seconds?, bucket_bump_seconds?}` |
| `PUT /api/telegram` | `{token: <secret input>}` or `{token: null}` |
| `GET /api/sticker-sets` | — |
| `POST /api/sticker-sets` | `{name, alias, note?}` |
| `PUT /api/sticker-sets/:alias` | `{alias?, note?}` |
| `DELETE /api/sticker-sets/:alias` | — |

Bucket timing is hot-applied, but a batch already collecting keeps the timing it opened with. All three numbers are integers 0–300; `bucket_window_seconds` cannot be removed, the other two accept `null` (the ceiling then follows the window, and the bump falls back to `0`). The cross-field rules — the ceiling covers the window, the idle grace covers the ceiling — are checked on the whole file, so a value that looks fine alone can still be a `422 config_invalid`.

`PUT /api/telegram` takes exactly one field. A plaintext token is registered before validation, a `{ "entry": ... }` reuses a Keychain entry, and `{token: null}` deletes it — destructive, because the jar entry it referenced is recycled. A token never carries whitespace or control characters.

Sticker sets: `name` may be a set name or a `t.me/addstickers/<name>` link, and its Telegram name is the identity — it cannot be edited afterwards, only the alias (a nickname, `[A-Za-z][A-Za-z0-9_-]{0,63}`) and the note. Adding or removing a set stops running Telegram invocations; the index of a removed set is kept for a later re-add.

## Outbound MCP servers

These are the servers the bot calls (`mcp.servers`), not the reverse `/mcp` endpoint. `GET /api/mcp-servers` returns each server with its live state, the tools it advertised and the Chats that bind it; a key or paired client gets redacted URLs and no secret origins.

| Route | Body |
| --- | --- |
| `POST /api/mcp-servers` | `{alias, url, headers?, tools, payload_max_bytes, result_max_bytes, tool_policies?, default_tool_policy?, exposure?, description?, skills?}` |
| `PUT /api/mcp-servers/:alias` | the same fields, all optional |
| `POST /api/mcp-servers/:alias/description-draft` | — (billed) |
| `DELETE /api/mcp-servers/:alias` | — |

- A stdio server cannot be created or moved from the panel: its argv is an arbitrary host program, which belongs in `config.jsonc` under the operator's hands. Creating one answers `400` with that instruction; editing an existing stdio server accepts only tool selection, limits, policies and presentation fields.
- `tools` is `"*"` or an explicit list; `payload_max_bytes` is 1–1 048 576, `result_max_bytes` 1–32 768.
- `exposure` is `direct` (every tool becomes its own tool) or `progressive` (all of them fold into the single `mcp` gateway tool). Omitted keeps the current value; `direct` drops the field because it is the default.
- `description` is what the model reads to choose the server; `null` or a blank string removes it. `skills: false` stops the model from reading the skills the server publishes.
- The draft route is the paid half of that form: it asks the tool model for a description of the *running* server and saves nothing. It answers `{alias, description, tool_model}`; `409 mcp_server_not_applied` when the file differs from the running server, `409 mcp_server_not_ready` before the server advertised any exposed tool, `502 tool_model_unavailable`.
- Deleting is refused with `409 mcp_server_in_use` while a Chat binds the alias; unbind it with `PUT /api/chats/:id/mcp` first.

## Bot admins, warnings and the config file

- `GET /api/admins` / `POST /api/admins` `{telegram_user_id}` / `DELETE /api/admins/:id` manage `telegram.admins`, the users allowed to run Bot admin commands; a positive safe integer, and adding one twice is a no-op.
- `GET /api/warnings?unread=&limit=&offset=&as_of=` lists standing and event warnings with the unread count; `POST /api/warnings/:id/read` marks one event warning read; `DELETE /api/warnings` deletes every stored event warning (destructive).
- `POST /api/config/apply` re-reads the file and applies the hot-updatable fields, answering `{status: "applied", applied, restart_required, outside_serve, generation, active_hash, file_hash}`; a refusal is `422` with the loader's code. `GET /api/config/status` reports the same numbers without writing.

## Keychain is not here

`/api/keychain*` manages the named secrets every form above writes into. It is **session-only**: no API key, paired client, CLI command or MCP tool can reach it, because listing or minting secrets would escalate the caller. Its routes are in the [panel session catalog](endpoints-session.md) and the workflow is in [Admin Panel, secrets and access](../../guides/admin.md).
