---
title: Agent settings
description: The main model's identity triple, token budget, sending rules, Context retention, concurrency and rate limits, and the two deprecated fields.
---

# Agent settings

`agent` is optional: omitting the section, writing `null` or writing `{}` are all legal. It decides who the main model is, how many tokens a day it may spend, what it may send, and how a long conversation is trimmed. Field by field see the [`agent` field reference](fields-agent.md).

## The identity triple

`provider`, `model` and `thinking_level` together decide whether any invocation starts:

- Missing one means "agent not configured": the process starts, due batches are closed as `skipped_budget`/`agent_unconfigured` without creating an invocation, and loading records a warning.
- With all three set, the model must exist under `providers`, accept `text` input, and accept the configured `thinking_level`.
- A chat may complete or override any of the three; when the global triple is incomplete but one chat has all three, only that chat runs.

`thinking_level` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; a non-reasoning model accepts only `off`. Switching the global model through the panel or `/model` resets the level to the weakest one the new model accepts.

## Budget

`daily_budget.max_tokens` (runtime default `1000000000`) is a **global** daily token ceiling shared by every chat; there are no per-chat quotas.

It counts every token of a model call: non-cached input, cache reads, cache writes and output, summed without overlap. Whether the model is free or the cache is cheap makes no difference — free models are metered too. A chat-triggered `read_image` counts against the same budget, because the main agent issued that call.

This is a circuit breaker for runaway invocations and tool loops, not a spending budget: when it is reached a run ends, and lowering it blocks the next model call without a restart.

## Sending

| Field | Effect |
| --- | --- |
| `send_max_text_length` | Maximum characters of a text message (1–4096). A longer send is recorded as `send_text_too_long`, never reaches Telegram and uses no send quota. Omitted means unlimited. |
| `send_disallow_blank_lines` | When on, text containing a blank line is rejected (`send_blank_lines`); paragraphs may only be separated by a single newline. Off by default. |
| `send_nudge_enabled` | When the model puts group-facing text into an ordinary message and never called `send`, a reminder is injected. Off by default. |
| `send_barrier_enabled` | Before the first real send of a round, if another batch is collecting in the same Conversation it is attached to the current run and this send is rejected (`send_barrier`), so the model reads it first. Off by default. |
| `allow_reply_message_multiple_times` | Defaults to `false`: one reply per message per Conversation (text, stickers and images share it). `true` disables that per-message de-duplication. |
| `send_duplicate_guard_enabled` | Defaults to `true`: within one run, text or a sticker identical to something already sent is rejected, and so is re-sending the previous content under a different reply target; more than 3 rejections end the run. Only an explicit `false` turns it off. |
| `send_empty_text_strategy` | What a `send` without text becomes: `reject` (the default, `send_input_invalid`), `silent_success` (success without sending; three consecutive silent successes end the run) or `random_text` (send one of the fallback texts). |
| `send_empty_text_fallback_texts` | The list used by `random_text`, runtime default `["……"]`; at least one entry, each a single line with a non-whitespace character, at most 4096 characters. |

All of these converge on the single send boundary `send`: ordinary assistant text is never published directly, and each part of a `send_reply` goes through the same pipeline.

## Conversation Context

`system_prompt_file` points at the persona prompt, resolved against the configuration file's directory; omitting it means an empty prompt (the core protocol lives in code and does not depend on it). The file must still have content after HTML comments are stripped, otherwise loading fails. Six template variables are available: `{{ agent.nickname }}`, `{{ agent.provider }}`, `{{ agent.model }}`, `{{ vision.provider }}`, `{{ vision.model }}` and `{{ timezone }}`; an unknown expression rejects the configuration.

`history_messages` (default `20`) caps how many earlier messages a new invocation freezes; batches attached to a running invocation carry no history.

`context_stop_ratio` (default `0.8`) is the closing threshold: once the estimated input reaches `context_window × ratio`, the next model call only exposes `send` and the `zzz` tool available at that moment, the model finishes in that turn, and the run ends with `context_limit`. It is also the upper bound for GC, and must be at least `context.hard_token_ratio`.

`context` holds the retention policy:

| Field | Runtime default | Effect |
| --- | --- | --- |
| `retained_sends_target` | `20` | How many `send` calls' worth of history to keep after trimming. |
| `retained_sends_max` | `30` | Trimming triggers when the retained span holds more `send` calls than this; must exceed `retained_sends_target`. |
| `hard_token_ratio` | `0.6` | Trimming criterion when estimated input plus the output ceiling reaches `context_window × ratio`. |
| `ref_ttl_hours` | `72` | Lifetime of `img_`, `stk_` and `reply:` references inside the Context. |
| `idle_grace_seconds` | `0` | How long a run keeps waiting for a new batch after a round. `0` means one batch per run; a value above `0` must be at least `telegram.bucket_max_seconds`. |
| `max_wall_clock_seconds` | `1800` | Wall-clock ceiling of a single run; must exceed `idle_grace_seconds`. |
| `agent_cache_size` | `32` | In-process cache of Pi agent instances; an evicted instance rebuilds an equivalent transcript from the database. |

Trimming drops history without summarizing: GC jumps the retained window forward by whole checkpoints. Evicted messages never reach the model again, but the conversation itself is not interrupted.

`idle_grace_seconds` is the only supported long-lived switch. Above `0`, batches that fall due while a run is alive are attached to the same invocation; `0` falls back to one invocation per batch while Conversation Context stays continuous.

## Concurrency and rate limits

- `max_concurrency` (default `4`): how many invocations may run at once, globally.
- `rate_limits.turns_per_injection` (default `24`): how many turns a run may take after one batch injection before ending with `turn_budget`; an injection resets it.
- `rate_limits.sends_per_window` (default `100`) and `window_seconds` (default `300`): how many `send` calls one chat may make in a sliding window.

These are runaway protections, not per-chat quotas; apart from the global token budget there are no daily quotas.

## Deprecated fields

- `agent.memory_ttl_warning_days`: nothing reads it, there is no replacement, delete it.
- `agent.send_empty_text_fallback_enabled`: the old switch; `true` no longer implies anything. To keep the old empty-text fallback, set `agent.send_empty_text_strategy` to `"random_text"` instead.

Both are still accepted by the Schema, produce a deprecated-field warning at load and stay listed on the panel's Warnings page. Adding, removing or editing them is a hot change and needs no restart. The full list is in the [configuration field reference](fields.md).

## How changes take effect

Every `agent` field is hot: the next invocation uses the new value, while a running invocation keeps the snapshot it started with. A path or content change of `system_prompt_file` moves the stable system prompt hash, so affected Conversations rebuild their Context on the next run. See [configuration lifecycle](lifecycle.md).
