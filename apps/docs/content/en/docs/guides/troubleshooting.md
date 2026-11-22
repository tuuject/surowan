---
title: Troubleshoot startup failures and silence
description: Triage startup failures, panel and pairing errors, model and image faults, entry gate drops, MCP degradation and a silent bot from evidence — then resume a failed run.
---

# Troubleshoot startup failures and silence

The order is always the same: preserve the scene, then let the evidence split the cases. Most "the bot is broken" reports turn out to be a configuration that was never applied, a gate that withheld the batch, or a model that chose silence.

**Preserve the scene.** Do not delete the database, the media cache or `serve.lock` while debugging. What you need is the time it happened, the `config_hash` printed by `check-config`, and the redacted event names and error codes.

## Startup failures

### The configuration file is invalid

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

It reads the file only: no secret resolution, no network. Success prints `{"status":"ok"}` with `config_hash` and `warnings`; failure prints `{"status":"error","error":"…"}` and exits with code 1.

Two kinds of error, and they read differently:

- **Shape errors** start with `Invalid config:` plus a field path, such as `Invalid config: /telegram: …`, and come from the schema: misspelled field, wrong type, a value outside an enum, a required section missing.
- **Cross-field and semantic errors** are full sentences that only code can judge. The common ones, verbatim:
  - `telegram.bucket_max_seconds must be at least telegram.bucket_window_seconds`
  - `agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_max_seconds (which defaults to telegram.bucket_window_seconds)`
  - `agent.context.retained_sends_target must be smaller than retained_sends_max`
  - `telegram.decision_gate.api_key is required when telegram.decision_gate.enabled is true`
  - `Chat <id> is a private chat and cannot configure participation` (same for `proactive_reply` and `decision_gate`)
  - `Chat <id>: provider and model must both be set when overriding agent settings`
  - `Invalid config: plaintext secrets are not accepted; …`

`warnings` never block startup but are worth reading one by one: incomplete model settings ("the bot will run without starting any invocation"), incomplete `vision` settings ("`read_image` and background sticker indexing are unavailable"), the deprecated `mcp.servers[].required`, the list of deprecated fields, and degradations such as "image generation disabled: the `image` section is invalid and was ignored".

### File permissions

On non-Windows systems `serve`, `doctor` and `pairing` all require the configuration file at `0600` and its parent directory at `0700`, and refuse to start otherwise:

- `Config must have mode 0600: <path>`
- `Config parent must have mode 0700: <path>`

Fix it with `chmod`; do not disable the check. Permissions on `data_dir` are only checked by `doctor`.

### A secret cannot be read

The configuration stores references (`{ "jar": "<entry>" }`, `env` or `command`) and resolves them when needed. Each section fails differently, which tells you where to look:

- **The Telegram token** does not block startup. The process keeps running, the connection state becomes *Configuration error* with reason `token_unreadable`, and a `telegram_config_error` warning appears. Save the token again on the **Telegram** page or fix the entry on **Keychain**.
- **The `image` section** drops to "image generation disabled" when its credentials cannot be resolved; the rest of the configuration stays usable.
- **The entry gate's `api_key`** is the sneakiest: loading succeeds, and every decision records `secret_unresolved` and then admits the batch, so it looks like a gate that always lets things through. Always run `doctor` once after enabling the gate.
- **A provider's API key** surfaces as `secret_unresolved` when the configuration is applied or a health check runs; invocations still start, and the model calls fail.

### Ports, locks and a second process

- One `serve` per `data_dir`. A second one fails with `Another serve process holds <data_dir>/serve.lock with PID <pid>`. Use `--takeover` only when you are deliberately replacing a local instance.
- The single-instance lock lives on `serve.lock.sqlite` and is released by the kernel when the process exits, container rebuilds included. `serve.lock` is only a human-readable PID file; a leftover one never blocks startup and must not be deleted by hand.
- An occupied panel port shows up as a startup failure. With `admin.host` set to `127.0.0.1`, the outside world cannot reach the panel at all — put a reverse proxy in front of it or change the bind address.

## The panel is unreachable or sign-in fails

1. **Is the process running?** The log should contain an `admin_started` event with the actual host and port.
2. **Blank page or 503?** An `admin_bundle_missing` response means the front end was never built: run `pnpm run admin:build` in a source checkout and restart. Official images ship with the bundle.
3. **Sign-in fails.** `invalid_credentials` means the username or password is wrong. Repeated failures lock the caller's address for a while and then return `too_many_attempts` (HTTP 429); wait it out instead of clearing the database.
4. **There is no account at all.** The panel has no web sign-up: the first administrator comes from the server, either `pairing create --web` (which creates a passwordless `admin`) or the offline `admin-account` while the service is stopped. See [Install and sign in](installation.md).
5. **Forgot the password.** With a passkey registered, use it on the sign-in page; otherwise reset with `admin-account` while the service is stopped. Neither is available to an API key or a paired client.

## Pairing and signature error codes

Pairing, client signatures and API keys use stable codes, so the table is enough:

| Code | Meaning and fix |
| --- | --- |
| `pairing_code_invalid` | Unknown or cancelled pairing code. Create a new one on the server. |
| `pairing_code_expired` | Past its lifetime (300 seconds by default). Create a new one; do not reuse the old code. |
| `pairing_code_used` | Already claimed. Each code works once. |
| `pairing_public_key_mismatch` | The pre-bound public key does not match. Use the key `auth init` printed, or create a code without `--public-key`; the code itself is not burned. |
| `pairing_proof_invalid` | The claim signature is malformed or wrong. Confirm `client-key.pem` was not replaced. |
| `client_already_paired` | This public key already has an active client. Revoke it on the server, or use another key. |
| `unauthenticated` | Unknown or revoked client, or a signature mismatch. An invalid, revoked or permission-broken API key also returns this. |
| `signature_clock_skew` | The machine or the server is more than ±300 seconds off. Fix the clock. |
| `signature_replayed` | The same nonce was used twice, which is what resending a request looks like. Re-run the command; do not work around it. |
| `missing_client_key` / `invalid_client_key` | The local private key is missing, modified, or has unsafe permissions. You decide whether to pair again. |
| `already_configured` | `auth pair` found a saved credential. Add `--force` only if you mean to replace it. |
| `forbidden` | The credential is valid but lacks a permission. Change the mode on **API keys**, or pair again. |

If `surowan pairing` or `surowan clients` reports a missing database or an unapplied migration, this version has not started on the server yet: start (or restart) `serve` once.

Checking first beats guessing:

```bash
surowan-utils doctor --json
```

`status: ok` means the connection and authentication both work, and `credential`, `mode` and `permissions` tell you which identity is in use and what it may do.

## Models and providers

- An `agent_model_missing` warning (critical) means `agent.provider`, `agent.model` and `agent.thinking_level` are not all set, so no batch can start a run.
- When an invocation ends as `failed`, the *Completion reason* and *Error code* on the detail page split the cases: `model_error` points at the provider and model capability, `daily_token_budget` at the budget, `timeout` at the maximum wall-clock time.
- The *Model calls* tab shows the provider, model, effort, duration and error of each request. Confirm it is asking the model you think it is.
- Provider connectivity is verified with the health check on **Providers**; it sends a minimal request and shows the model's own reply, so it both finds errors and proves the model answers.
- A loadable configuration does not mean a usable model: `check-config` validates references and declared capabilities, it never talks to the provider.

## Images and stickers

- The `vision_model_missing` warning only says `vision.provider` / `vision.model` are incomplete. Ordinary in-chat images may still be handled directly by a multimodal agent model, but `read_image` and background sticker indexing are unavailable.
- Tool call error codes: `vision_unconfigured` means no vision model is configured, `image_ref_not_authorized` means the referenced image is not visible in this conversation or has expired, and `vision_timeout` / `vision_error` mean the analysis or the upstream call failed.
- Sticker indexing progress lives on **Bot sticker sets**; indexing needs a vision model and spends `vision.daily_budget`, which is separate from the agent's daily budget.
- When the whole `image` section was ignored, the `warnings` from `check-config` name the offending fields. Fix or delete the section to re-enable generation.

## Entry gate: withheld or broken key

The two "it just will not answer" cases look different in the audit:

- **Actually withheld**: the batch ends as `skipped_budget` with error code `decision_gate_dropped`, and a decision row exists with `outcome` `drop`. The gate is doing its job.
- **Broken key**: the decision row has `error_code` `secret_unresolved` but `outcome` `enter` — the gate admitted the batch. Repair the keychain entry or re-enter the key, then run `doctor` and confirm `decision_gate` is `connected`.

The other decision error codes all admit the batch: `timeout`, `network_error`, `http_error` (with an HTTP status), `invalid_response` and `refusal`. `concurrency_limit` means 4 decisions were already in flight and this batch went straight through. A `state` of `stale` means the verdict was discarded because new messages arrived and the batch was asked again — not a failure.

Decision rows are read through the client CLI or HTTP; there is no list page in the panel:

```bash
surowan-utils decision-gate decisions --chat <chat ID> --limit 50
```

## Outbound MCP: degraded and missing descriptions

- The `mcp_server_unavailable` warning lists the degraded servers with an `error_code` and the next reconnect time. Common codes: `initialization_failed` (handshake or tool discovery failed), `transport_error` (connection dropped), `payload_limit` (request or result exceeded the configured limit), `redirect_rejected` (the HTTP transport does not follow redirects) and `reconnect_failed`. Servers reconnect on their own; no restart is needed.
- **`mcp_description_missing`** only appears on servers with `exposure: progressive` and no `description`: the gateway can only fall back to a few tool names, so the model has little idea what the server is for. Add one sentence, or draft it with the tool model on **MCP servers**.
- **`mcp_required_deprecated`** says a `mcp.servers[].required` remains in the file. It no longer does anything; delete it.
- Startup no longer waits for MCP: an unreachable server only degrades itself and never keeps the bot from starting. A failing tool call lands in *Tool calls* on the invocation detail, with codes such as `mcp_tool_error` or `mcp_call_failed`.

<!-- screenshot: troubleshooting/mcp-degraded | The Warnings page listing a degraded MCP server and its error code -->

## Group memory batch failures

Consolidation progress on **Group memory** shows the problem directly: a lane in the state *N consecutive failures* with a retry time. *View batches* adds a *Reason* per batch:

| Reason | Error code | Meaning |
| --- | --- | --- |
| Invalid model output | `group_memory_invalid_output` | The reply failed the event schema and message-id validation. The model is asked to repair it once; failing that, the batch fails. |
| Output truncated | `group_memory_length` | A reply hit the output limit before it finished. |
| Model error | `group_memory_error` | The upstream call failed. |
| Tool model unavailable | `tool_model_unavailable`, `group_memory_unavailable` | `tool_model` is incomplete, the model is unusable, or no message in the batch fits the model window. |
| Aborted | `group_memory_aborted` | Model calls were no longer allowed while the batch ran. |
| Process stopped / interrupted by restart | `shutdown`, `interrupted` | The service exited or restarted mid-batch. |
| Claim timed out / batch voided | `stale_claim`, `group_memory_claim_lost` | Another round claimed the batch, or its claim expired. |
| Group memory disabled / other | `group_memory_disabled` and anything unlisted | A leftover batch after group memory was turned off, or an unclassified error. |

A failure never loses messages: the lane returns to idle with a backoff and retries later. If it keeps failing, check that `tool_model` works (it does not follow per-chat overrides) before splitting the day into smaller batches.

## Configuration drift and deprecated fields

"I changed the configuration and nothing happened" is almost always one of these:

- **The file was never applied.** After a hand edit, press *Apply config file* on **Settings**. The *Config file* group shows the active hash, the file hash and whether the file matches the running configuration, and *Last error* explains the last failed apply. Fields that need a restart produce a *N settings are waiting for a restart* banner with *Restart now* at the top of **Chats**.
- **The field only applies after a restart.** Which fields are hot and which are not is in [Configuration lifecycle](../configuration/lifecycle.md); hot fields show *Running: …* under the input when the running value differs.

<!-- screenshot: troubleshooting/config-drift | The Settings page showing a file hash that differs from the active hash -->

**Deprecated fields** have no effect at all. `check-config` lists their paths in `warnings` and the Warnings page reports `config_fields_deprecated`. To clean up: `agent.memory_ttl_warning_days`, `agent.send_empty_text_fallback_enabled` (use `agent.send_empty_text_strategy: "random_text"` instead), `vision.background_sticker_concurrency`, and `mcp.servers[].required`.

## The bot is silent

Work through this in order and stop when one step explains it:

1. **Was the message stored?** The **Messages** page filters by chat and time. If it is not there, it never reached the bot (privacy mode, restricted permissions, chat not in scope).
2. **Is the chat in scope?** Chats missing from `telegram.chats` are never processed; after adding one, confirm *Status* says *Active*.
3. **May it open a batch?** Outside active hours only `/ask`, a direct mention, a reply to the bot's own message or a keyword can; with `/ask`-only, only `/ask`. Both live under *Edit active hours* on **Chats**.
4. **Is the chat paused?** `/pause` keeps storing messages but starts no runs, and *Administrator pauses* on Overview lists them.
5. **Is the bot sleeping?** Overview shows the sleep state and wake time, and batches close as `sleeping` meanwhile. *Wake now* resumes work but does not replay skipped batches.
6. **Did the entry gate drop it?** See `decision_gate_dropped` above.
7. **Did any invocation exist?** Filter **Tool sessions** by chat. No invocation means one of steps 1–6; one exists, so open it.

On the detail page:

- *State* `completed` with zero sends means the model read the batch and chose silence. That is a normal outcome.
- `failed`, `aborted` or `outcome_unknown`: read *Completion reason* and *Error code*; this is the case where resume may help.
- A `send` tool call that failed carries the reason: a send rule (duplicate, empty text, length, reply target), a permission, or a Telegram-side rejection.

<!-- screenshot: troubleshooting/tool-calls | An invocation detail showing tool calls and the Telegram send result -->

When the panel does not answer the question, read the same audit from a shell:

```bash
node scripts/audit.ts invocation <invocation ID>
```

It prints one run's queued time, context, model calls, tool calls and sends as a timeline, including the states and error codes used above.

## Resume a failed run

The latest `failed`, `aborted` or `outcome_unknown` invocation of a conversation can be resumed from its detail page. It runs again for real with the current configuration and may send and cost money, so API-key callers need `write+paid`.

Refusals name the reason directly:

| Code | Meaning |
| --- | --- |
| `resume_not_failed` | Only failed, aborted or outcome-unknown runs can be resumed. |
| `resume_not_latest` | A later invocation exists in this conversation; only the latest can be resumed. |
| `resume_conversation_busy` | The conversation still has a queued or running invocation. |
| `resume_host_unavailable` | Telegram is disabled or not connected, so the run could not start either. |
| `resume_sleeping` | The bot is sleeping; wake it first. |
| `resume_chat_removed`, `resume_topic_removed`, `resume_chat_paused` | The chat is gone, the topic is no longer allowed, or the chat is paused. |
| `resume_agent_unconfigured` | The chat's model configuration is incomplete. |
| `resume_unsupported_host` | Playground failures retry through the room's own retry, not resume. |

<!-- screenshot: tuning/invocation-resume | A failed run's detail page with the Resume button and the auto-refresh controls -->

Resume is not replay: replay produces no Telegram side effects and does not continue the conversation's context. See [Invocation preflight and replay](../developer/replay.md).

## Still stuck

Bring these and the conversation will be short: the full `check-config` output (the `config_hash` matters), event names and error codes, the time range, the affected chat IDs, and one invocation ID. Redact anything sensitive first — never paste tokens, API keys, `key.json` or full message bodies.
