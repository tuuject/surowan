---
title: Configuration lifecycle
description: Absent versus null, inheritance from global to Chat to Topic, the file and the running snapshot, explicit apply, hot changes versus restarts, and deprecated fields.
---

# Configuration lifecycle

The configuration file is only the desired state. The process reads it once at startup and again only on an explicit apply; each apply sorts the file's changes into three groups: what can take effect immediately, what waits for a restart, and what `serve` never reads. This page explains those rules. Field types and defaults are in the [configuration field reference](fields.md).

## Three layers

| Layer | Meaning |
| --- | --- |
| File | `config.jsonc` on disk plus the prompt files and `key.json` it points at. Panel saves and hand edits both change this. |
| Active configuration (running snapshot) | What the current process is running. It can differ from the file whenever a restart-only field is pending or the file was edited without applying. |
| Saved but pending restart | Written to the file, but only a restart brings it into the running snapshot. |

The panel's Settings page shows all three: **Generation** (one per apply), **Active hash**, **File hash**, plus pending restarts and the last error. Equal hashes mean "matches the file"; different hashes mean "file has changes".

The configuration hash is the SHA-256 of the raw file bytes plus the content of every prompt file. The `config_hash` printed by `check-config`, the one in the `serve_started` log entry and the one on the panel are the same value, so you can compare them directly.

## Absent and null

- Omitting an optional section means "not configured": no `telegram` disables Telegram, no `vision` means no vision model, no `image` means image generation is disabled.
- `agent` and `vision` may also be `null`, which is the same as omitting them. `agent: {}` is legal too: every other field takes its default, but the model identity triple (`provider`/`model`/`thinking_level`) is still incomplete, so no Invocation starts.
- Inside a present section, required fields stay required. Writing `telegram` means writing `process_bot_messages`, `bucket_window_seconds` and `chats`; `token` is the exception and may be omitted.
- An omitted field is not the same as no behaviour: most fields have defaults, below.

## Where defaults come from

Defaults have two sources, and the generated pages label them apart:

- **Schema default**: the `default` on a Schema node. Today only a few booleans have one (for example `developer.record_model_payloads`).
- **Runtime default**: the value the resolving code uses when the field is absent, taken from constants such as `AGENT_DEFAULTS`, `VISION_DEFAULTS`, `TELEGRAM_DEFAULTS`, `DECISION_GATE_DEFAULTS` and `PROACTIVE_REPLY_DEFAULTS`. Whether it applies depends on how far that resolver reaches: `agent` and `vision` are filled field by field, so runtime consumers always read concrete values, while a field that is required inside `telegram` (such as `bucket_window_seconds`) only has a default when the whole section is absent.

A field without a single shared default — `vision.thinking_level` depends on the selected model, and `tool_model` inherits the global agent — has no default printed in the generated pages; the hand-written page explains the rule.

## Inheritance: global → Chat → Topic

| Setting | Rule |
| --- | --- |
| `agent.provider` / `model` / `thinking_level` | The global section is the default and `telegram.chats[]` may override each field. `provider` and `model` must be written together; `thinking_level` may be written alone. A Topic uses its Chat's settings. |
| `telegram.participation` | Windows are replaced wholesale (a Chat that writes `active_windows` uses its own), keywords are appended to the global list, and the attention window length overrides the global one. |
| `telegram.proactive_reply` | Inherited field by field: a Chat only writes what it changes. |
| `telegram.decision_gate` | The six behaviour fields (`enabled`, `mode`, `threshold`, `history_messages`, `pending_messages`, `instructions`) are inherited field by field; `model`, `base_url`, `api_key` and `timeout_ms` are global only and cannot be written on a Chat. |
| `dictionary.injection_mode` | A Chat's `dictionary_injection_mode` overrides the global one; omitting it inherits. |
| `telegram.chats[].group_memory` | Chat level only; there is no global default. |
| `telegram.chats[].mcp` | Chat level only: it narrows the tool set of an already configured server, it never overrides connection settings. |
| `tool_model` | When omitted it inherits the **global** agent triple and follows no Chat override. See [tool model settings](tool-model.md). |

Private chats (positive Chat IDs) ignore `participation`, `proactive_reply` and `decision_gate`; configuring any of them there is rejected by `check-config`.

## Explicit apply: there is no file watcher

Editing the file does nothing by itself. There are three ways to hand it to the running process:

1. The **Apply config file** button on the panel's Settings page (`POST /api/config/apply`).
2. Any panel save that writes the configuration: Providers, Models, Prompts, Chats, Harness tuning, Telegram and the others all "write the file, then apply". Settings that live only in the database (memories, dictionary, alarms) are not configuration writes.
3. Telegram commands: `/model`, `/effort`, `/ignoreme`, `/unignoreme` and `/allowlist` also write the file and apply it.

`serve` reads the file once at startup and never looks at the disk again, so "saved" and "active" are different states — the panel distinguishes them with the active and file hashes.

## Partial apply and pending restarts

One apply builds a candidate out of the file's hot fields plus the restart-only fields still active in the running snapshot:

- Hot fields take effect at once and appear in the result's `applied` list.
- Restart-only fields keep the running value and go into `restartRequired`; the panel shows "Restart required" and a restart brings them in together.
- `paths.backups` and `retention.backup_copies` are a third kind: `serve` never reads them, the next `backup` does, and the panel shows "Not used by the running service".
- Pending restarts are not cleared by later hot-only applies. Applying with the restart-only field reverted to its active value is what removes it.

The candidate is validated again. A file that is valid on its own but invalid together with the pending restart-only fields fails the apply with `candidate_invalid`, and the error names the pending paths; the file stays on disk and becomes effective after a restart.

Every successful apply logs `config_reloaded` with `generation`, `active_hash`, `file_hash`, `applied`, `restart_required` and `outside_serve`; failures log `config_reload_failed` with an error code and a redacted message. The codes are `config_invalid` (the file itself is invalid), `candidate_invalid` (it conflicts with pending restart-only fields), `model_unusable` (a model is missing or unusable), `secret_unresolved` (a new or changed provider cannot resolve its SecretRef) and `publish_incomplete` (published, but a publish hook failed; applying again retries it).

## Behaviour matrix

The table lists representative changes. `hot` means the next explicit apply is enough, `restart` means it waits for a restart, `outside_serve` means only `backup` reads it. `test/docs/lifecycle.test.ts` re-derives every row from a real configuration diff.

| Change | Effect | Notes |
| --- | --- | --- |
| Adding a `telegram.chats[]` entry | hot | The ingestion allowlist, participation registry and Chat resolution all read the published configuration; a new Chat has no history to protect. |
| Removing a `telegram.chats[]` entry | hot | Publishing stops that Chat's running invocations and long tasks (`telegram_chat_removed`) and rejects its later updates. Stored data is **not** deleted; deleting data is a separate panel/API action. |
| `telegram.chats[].topic_ids` | restart | Topic ranges need a restart; until then new Topics are still judged by the old range. |
| `telegram.chats[].timezone` | restart | Participation windows are resolved in the Chat's timezone, so the timezone itself needs a restart. |
| `telegram.chats[].provider` / `model` / `thinking_level` | hot | Per-Chat model override; the next invocation uses it. |
| `telegram.chats[].instructions_file` (path or content) | hot | A content change moves the stable system prompt hash, so that Conversation's Context is rebuilt on its next run. |
| `telegram.chats[].ignored_user_ids` | hot | The next live or catch-up update uses the new list; existing messages and Context are not rewritten. |
| `telegram.chats[].participation` / `proactive_reply` / `decision_gate` | hot | Each judgement, sample and decision re-reads the published configuration. |
| `telegram.chats[].group_memory` | hot | The next sleeping scan uses the new value; toggling it stops that Chat's runs and rebuilds their Context. |
| `telegram.chats[].mcp` | hot | Narrowing stops the Chat, rebuilds Context and resumes; widening alone does not interrupt a run. |
| `telegram.chats[].dictionary_injection_mode` | hot | Applies to the next invocation. |
| `agent.system_prompt_file` (path or content) | hot | Affects every Conversation's stable system prompt; their Contexts are rebuilt on the next run. |
| Any other `agent.*` field | hot | The next invocation uses it; lowering `daily_budget.max_tokens` blocks the next model call. |
| `providers.*` | hot | A provider whose connection fields changed re-resolves its SecretRef; a model-list-only change keeps the existing connection. Models the file references must stay valid. |
| `mcp.servers` | hot | Servers connect in the background, a failure is published as `degraded` and retried with backoff; affected Chats are stopped, rebuilt and resumed. |
| `telegram.decision_gate` and `telegram.chats[].decision_gate` | hot | Every decision re-reads the settings and the credential reference, so changing the threshold, model or endpoint needs no restart. |
| `telegram.bucket_window_seconds` / `bucket_max_seconds` / `bucket_bump_seconds` | hot | Only affects batches opened afterwards; a batch already collecting finishes with the timing it started with. |
| `telegram.sticker_sets` | hot | Reconciled into storage on publish; adding or removing a set aborts running Telegram invocations, editing `alias`/`note` does not. |
| `telegram.admins` | hot | The next command uses the new list. |
| `telegram.token` | hot | The connection manager follows the resolved token, so rotating or clearing it needs no restart. |
| `telegram.process_bot_messages` | restart | Whether other bots' messages are processed needs a restart. |
| `models_dev` / `models_dev.api_url` | hot | The panel's next metadata lookup uses the new address (each address is cached for an hour). |
| `retention.online_days` | hot | The periodic retention sweep (at startup and every 24 hours) reads the current window on every run. |
| `retention.warning_read_days` | restart | Warning cleanup reads it at process startup. |
| `retention.backup_copies`, `paths.backups` | outside_serve | Only `backup` and the pre-migration backup rotation read them. |
| `vision.provider` / `model` / `thinking_level` / `max_output_tokens` | hot | The next image analysis uses the new model and level. |
| `vision.max_concurrency` / `prompt_version` / `daily_budget` | restart | The semaphore, cache version and sticker-index budget are read when the service is constructed. |
| The whole `image` section | hot | Every apply re-resolves the image SecretRefs and publishes a new image snapshot atomically; a stripped or removed section means disabled. |
| `dictionary`, `tool_model`, `web_search`, `developer` | hot | The next invocation, helper call or search reads the new value. |
| `web_fetch` | restart | Address and format switches are read when the capability is constructed. |
| `admin.*` | restart | Listener, port, static directory, `public_url` and session lifetime all need a restart. |
| `data_dir`, `timezone`, `paths.database`, `paths.media_cache` | restart | Process-level paths and the default timezone. |

One class of change never shows up in the field diff: **keychain rotation**. Replacing a `key.json` entry in place leaves the configuration untouched, yet an apply still compares the digest of every referenced entry (a SHA-256 held in memory, never written, logged or returned) and rebuilds the providers that use it, reconnects the MCP servers on the hot path, re-reads the Telegram token and re-prepares the image snapshot. Rotation is therefore another reason to apply, and never a reason to restart. See [secrets and paths](secrets.md).

## Deprecated fields

Three compatibility fields (`agent.memory_ttl_warning_days`, `agent.send_empty_text_fallback_enabled`, `vision.background_sticker_concurrency`) plus `mcp.servers[].required` are still accepted by the Schema but nothing reads them:

- Loading produces a warning: `warnings` from `check-config` and the `config_warnings` log event from `serve` both name the fields.
- The panel's Warnings page lists them as a standing warning until they are deleted.
- Adding, removing or editing them counts as a hot change: no restart, and the only difference is the warning.

The full list with replacements is in the deprecated-fields table of the [configuration field reference](fields.md).
