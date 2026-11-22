---
title: Invocation preflight and replay
description: Re-run one historical invocation's public input with the current prompt, model and tools, after a free preflight, and know the slicing, overrides, fidelity limits and cost.
---

# Invocation preflight and replay

A replay takes the **historical public input** of one finished invocation and runs it again with the **current** prompt, model and tool definitions to see how it would answer today. It sends no Telegram message, does not touch the production context and writes no business data — but it does **call a model for real and bill it**, and the usage is not charged to the production budget (`fidelity.production_budgets` is `not_charged`).

The entry points are the CLI, the HTTP API and MCP, all with an API credential. A panel session cannot replay, and there is no replay page in the panel:

```bash
surowan-utils invocation preflight 12345 --json     # free
surowan-utils invocation replay 12345 --json        # billed
```

The routes are `GET /api/invocations/:id/replay-preflight` and `POST /api/invocations/:id/replay` (see [Audit, resume and export API](http/audit.md)); the MCP tools are `surowan_invocation_replay_preflight` and `surowan_invocation_replay`.

## Not the same thing as Resume

| | Replay | Resume |
| --- | --- | --- |
| What it does | Rebuilds the historical scene and runs it in a **new**, synthetic run | Runs a failed invocation **for real** again |
| Sends to Telegram | No: `send` only collects into `outputs` | Yes, it is a production run |
| Changes the production context | No | Yes, into canonical history |
| Cost | Billed, at the current model | Billed, at the run's model |
| Entry points | CLI, HTTP, MCP | Panel, `POST /api/invocations/:id/resume`, MCP's `surowan_invocation_resume` |

Resume is only allowed for the newest `failed`, `aborted` or `outcome_unknown` invocation of a conversation, and it may repeat messages that were already delivered — because it really delivers. A replay never sends, so you can run it freely; the only cost is money.

## Preflight

Preflight is free and read-only, and it comes first. It answers "can this be replayed", "can the prompt layers be replaced" and "what does the scene look like":

| Field | Meaning |
| --- | --- |
| `available` | Whether replay is possible; when it is not, `reason` is a stable code and `message` explains it |
| `prompt_overrides_available` | Whether this scene may replace the global/group prompt layers |
| `scene` | `cutoff_at`, `source_bucket_id`, `message_count`, `history_count`, `omitted_messages`, plus `slice` for a sliced replay |
| `model` | The `{ provider, id, thinking_level }` this run would actually use, when a selection was given |
| `fidelity` | The fidelity table below, limited to what is knowable before the run |

Refusals (the code is the `reason`):

- `replay_source_unfinished`: the source invocation has not finished.
- `replay_host_unsupported`: replay supports configuration-backed hosts only — today Telegram. Playground room runs cannot be replayed.
- `replay_chat_unconfigured` / `replay_topic_unconfigured`: the source chat or topic is no longer configured.
- `replay_model_unavailable`: the current chat's agent model is missing or unregistered.
- `replay_model_pair_required`, `replay_thinking_level_invalid`, `replay_thinking_level_unsupported`, `unknown_provider`, `unknown_model`, `not_text_capable`: an invalid model override.
- `invalid_before_send_id`: the slice boundary is not a positive 64-bit decimal id.

You do not need the Developer payload recording. The scene is rebuilt from the message, revision and invocation-snapshot tables, so turning recording off or clearing payloads does not affect replays, and the source invocation need not have called a model at all.

## What the scene contains

By default the scene is the input the model should have seen when the invocation's opening batch was frozen:

- The opening batch (its frozen `new` snapshots). Batches attached later, later edits and the bot's later replies are excluded.
- The history that provably existed at that time: frozen history wins; the rest comes from revisions and arrival times before the source invocation was created, while the current history limit, `/cut_topic` and the chat/topic allowlist **still apply**.
- Missing revisions are only counted (`omitted_messages`); a later edit never stands in for them.

The runtime block carries `current_time` only (the opening freeze time by default); the Memo Pad, sticker catalog and task receipts are not read. When the current model accepts image input, the photos, stickers and image documents this scene authorises and that are still retained get **scene-local** references; reading them only normalises the bytes for the model — the production Vision model is not called and no analysis is cached.

## Prompt overrides

Only the global and group layers may be replaced. The fixed protocol and the composed system prompt cannot:

```bash
surowan-utils invocation replay 12345 --global-prompt prompt.txt --json
surowan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' 'a temporary global prompt' | surowan-utils invocation replay 12345 --global-prompt - --json
```

- Each layer is capped at 65,536 characters. Global may not be empty after trimming; group may be empty, which clears it explicitly.
- The two `-` stdin sources cannot be combined.
- Content is validated against the current template whitelist. When preflight reports `prompt_overrides_available: false`, the CLI stops with `replay_prompt_parts_unavailable` and sends no POST.
- Overrides apply to this run only and are never written back. `invocation prompts <id>` returns the two layers **currently** in effect (`source: active`), not a historical record.

## Model and thinking overrides

```bash
surowan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
surowan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
```

- `--provider` and `--model` must be supplied together; `--thinking-level` takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` and may be used alone (changing only the level, keeping the chat's model).
- A model pair without a level uses the weakest level that model supports (`off` for non-reasoning models); a level the model does not support is rejected by the server.
- Preflight and replay must use the same selection, otherwise the scene you inspected is not the one that runs.
- An override changes no configuration, context, audit or budget, but it does change prompt variables, image capability, the context budget, tool schemas, the provider connection and the real cost. The returned `model` and `fidelity.model_selection` (`current_chat_config` or `temporary_override`) tell you which one ran.

`surowan-utils models list` only lists configured models that accept text input; it probes nothing and listing a model is not an authorisation to use it.

## Sliced replay

With `--before-send <telegram_sends internal id>`, replay no longer rebuilds the whole opening batch; it takes only the small piece of public input before one successful bot message:

- The window sits strictly **after the previous bot message and before the target message**, both ends excluded. The target must be a successful send of this invocation; the previous bot message may belong to another invocation of the same conversation; without one, the window starts at the beginning of the retained input.
- Only frozen, already-injected public messages are included. Batches injected before the target send are flattened into a single batch instead of being replayed bucket by bucket (model concurrency and network latency can still introduce waits); an injection whose time is not strictly earlier than the send request is omitted, because a same-millisecond order cannot be proven.
- No earlier history is read, and no historical reasoning, tool result or system prompt is restored. The original bot answer never enters the model; it stays in the audit for comparison. Reply references cannot leave the window.
- The response carries `scene.slice = { before_send_id, before_message_id, after_bot_message_id }`, `history_count` is 0, and `cutoff_at` is the **request start** of that send, not its delivery time.
- An empty window gives `replay_slice_empty`; a target that is not a successful send of this invocation gives `replay_slice_target_invalid`.
- A sliced replay is billed like any other, so the CLI requires `--confirm-paid`. Without it, the command stops with `confirm_paid_required` (exit code 2) before reading stdin, before the preflight and before any POST. The free preflight rejects that flag, but preflight and replay must use the same `--before-send`.

If you do not know the id, search for it first:

```bash
surowan-utils invocation list --search 'keyword' --at '2026-09-10 07:59' --json
```

Bot entries in the result carry `telegram_send_id`, which is the candidate to use. The same invocation's sends to other conversations also appear in search results, but those cannot be its slice target.

## Fidelity limits

`fidelity` and `overrides` in the response are the whole list:

| Field | Value | Meaning |
| --- | --- | --- |
| `input` | `historical_public_chat` | The input is historical public messages only |
| `model_selection` | `current_chat_config` / `temporary_override` | Current chat settings, or this run's override |
| `prompt_selection` | `current_chat_config` | Prompt and templates come from the current configuration (a layer may be replaced) |
| `tool_selection` | `current_registry` | Tool definitions come from the current registry |
| `hot_injections` | `not_replayed` / `flattened_before_send` | Later hot injections are not replayed; slice mode flattens only what provably happened before the send |
| `external_tools` | `blocked` | Web fetch, sticker search, MCP and other external capabilities are refused |
| `system_resources` | `current_read_only` | `read` serves the **current** system documents |
| `side_effects` | `synthetic` | `send`, typing, image generation and `zzz` are synthesised |
| `memory_and_alarms` | `empty_in_memory_overlay` | The Memo Pad and alarms start from empty memory |
| `production_budgets` | `not_charged` | Production daily budgets are untouched |
| `dispatch_mode` | `execution_path_not_success` | `dispatches[].mode` names the path taken, not an outcome; success is in `tool_calls` |

A few more consequences:

- `send` validates the current arguments, text limits and the scene's reply targets, but there is **no** real send rate limiting, sticker world state or generated-asset check. A synthetic success is not a production success.
- The scene time is the opening freeze time by default and the target send's request start in slice mode. The Memo Pad, task receipts, global sleep state and send reminders of that moment are not restored.
- One replay runs at a time: a concurrent request gets `replay_busy` (HTTP 429). A single run is bounded at 128 tool calls, 240 seconds of wall clock, 20 turns (and no more than the current `turns_per_injection`) and 1 MiB of `trace`; exceeding a bound ends the run with an explicit `error`.
- Model requests inside a replay are never retried. A model that chooses not to speak (no `send` in the output) is a normal outcome: `responded: false`, `send_count: 0`.
- A non-empty `error` means the replay did not finish normally, but the full structure is still returned; the CLI prints it first and then exits with `replay_failed` (exit code 1). The CLI's request timeout defaults to 300 seconds.

## What the result contains

`version`, `replay_id`, `source_invocation_id`, `scene`, `conversation_id`, `chat_id`, `thread_id`, `model`, `overrides`, `started_at`, `finished_at`, `latency_ms`, `completion_reason`, `responded`, `send_count`, `outputs`, `tool_calls`, `usage` (including the `model_calls` turn count), `trace`, `error` and `fidelity`.

Text is redacted against the API key, and the shape stays structured JSON so a coding agent can diff "same scene, different prompt or model".

## Practical advice

- Preflight first, then replay. When a replay is unavailable, do not retry — the reason code is stable.
- Change one variable at a time: a prompt layer or a model, not both, or you cannot attribute the difference.
- Replay is an evaluation tool, not a repair tool. To change production state use the panel, the [configuration and gate API](http/configuration.md), or Resume.
- Treat replay as its own authorisation: permission to query is not permission to replay, especially when an agent decides how many runs to make.
