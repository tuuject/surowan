---
title: Tune behaviour and cost
description: Work from symptoms — too noisy, too slow, too expensive, not joining in, saying odd things — to the one knob that helps, then check the result in the audit.
---

# Tune behaviour and cost

Tuning is not a pass over every field. It is: find out *which batch* was handled *why* and *at what cost*, change one knob, then collect the same evidence again. This page is organised by symptom and names the knob plus where to look afterwards. Field definitions, defaults and apply rules live in [Agent settings](../configuration/agent.md) and [Telegram settings](../configuration/telegram.md); they are not repeated here. Field-by-field types and defaults are in the [`agent`](../configuration/fields-agent.md) and [`telegram`](../configuration/fields-telegram.md) field references.

One thing to internalise first: **the bot staying quiet is often the correct outcome**. Whether to speak is the model's decision, so a run with zero sends usually means it read the batch and chose silence (a blocked send shows up in the tool calls). The question to investigate is "did it get a chance to read it", not "did it say something".

## Read the evidence first

Before changing anything, settle on three places and look at all of them before and after each change:

- **Tool sessions** (`/invocations`). The list filters by chat, state, model and time. On the detail page, *Summary* gives state, completion reason, error code, tokens and cost, while the tabs break out *Tool calls*, *Model calls*, *Telegram sends*, *Agent transcript* and *Frozen context*. What the model saw is the frozen context; what it did is the tool calls and sends.
- **Warnings**. A standing list of conditions that are true right now: incomplete model settings, a Telegram connection that is down, a degraded MCP server, deprecated fields still in the file. A cleared condition simply disappears; there is no history.
- **Overview** daily usage. Switch between 7 and 30 days and watch model tokens, invocations, tool calls and the state breakdown. It also shows the sleeping state and the wake button.

The entry gate is the one audit surface with no page in the panel: its decision rows are read through the client CLI or HTTP (see [The entry gate](#the-entry-gate-decisions)).

## Symptom to knob

| Symptom | Reach for this first | Then look at |
| --- | --- | --- |
| Too noisy: it joins in when nobody called it | Proactive reply chance, entry gate, active hours or `/ask`-only | Invocation and send counts in tool sessions; the gate's decision rows |
| Too slow: it answers late when called | Message batch timing | The run's *Created* time and the timing that was in effect |
| Too expensive: tokens and cost climb | Daily budget, entry gate, context and history size, rate limits | Overview daily usage and each run's model calls |
| It does not join in at all | Allowlist, active hours, `/ask`-only, pause, sleep, entry gate | Whether the message was stored; whether any invocation exists |
| It says odd things: wrong tone, repeats, empty sends | Persona and per-chat prompts, model and thinking effort, send protection | The rejected tool calls and their error codes |

## Too noisy: it joins in too often

Three layers stack, cheapest first:

1. **The entry gate** (below) is the most targeted: a small decision model is asked "would you reply to this batch" before the batch reaches the main model. Under `enforce`, a rejected batch starts no invocation at all, so it cannot produce a reply.
2. **Proactive reply chance** (below) only applies to ordinary group messages that were not addressed to the bot. Mentions, replies, trigger keywords and `/ask` bypass it completely.
3. **Active hours and `/ask`-only** rewrite *which messages may open a batch at all*. Blunter, but also the cheapest: outside the schedule, or with `/ask`-only on, ordinary messages never open a batch. Configuration for both is in [Set boundaries per chat and topic](chats.md).

Above all three sits the persona prompt itself. If the prompt asks it to chime in whenever a topic looks interesting, the three knobs only damp the frequency; they do not change the disposition. See [Your first persona](first-persona.md).

## Too slow: it answers late

Two segments make up the wait, and both are visible in a run:

1. **The batch is still collecting.** After the first message arrives the bot waits a little before handing the batch over; that is the message batch timing (below).
2. **It is queued or running.** `agent.max_concurrency` caps how many invocations run at once, and `agent.context.max_wall_clock_seconds` caps a single run.

Start by lowering the *minimum wait* (5 seconds, for example), then decide whether the *maximum wait* should shrink too. Shortening both chops the conversation into smaller batches, so short lines may each end up in their own batch.

## Too expensive: tokens and cost climb

- **Daily token budget**, `agent.daily_budget.max_tokens`. It meters replies and in-chat image reading together and sums per scope: every Telegram chat shares one pot, and Playground rooms have another. It is a runaway breaker, not a dollar cap — set a real limit on the provider side as well.
- **The bot sleeps when the budget runs low.** Below 5% remaining the model may see the `zzz` tool; calling it sleeps until at least 8 hours later or the next UTC daily reset, whichever is later. During sleep, new batches close as `sleeping` and are not replayed. *Wake now* on Overview lifts it, but does not replay what was skipped.
- **The entry gate is outside the daily budget.** Decision requests record their own tokens and cost on the decision row (`input_tokens`, `cost`) and never touch daily usage, so enabling the gate costs a little extra instead of eating the bot's budget.
- **Context and history**: `agent.history_messages` sets how much earlier conversation each run carries, and `agent.context` decides when history is dropped, how long references live and how many contexts stay in memory. Shrinking them is the most direct saving, at the price of a shorter memory.
- **Rate limits do not save money**: `agent.rate_limits` caps send frequency and turns per injection. It stops a runaway conversation, it does not reduce model calls that already happened.

Two kinds of run deliberately skip the budget: when an alarm or a recurring alarm comes due, it does not count against the daily budget and still runs while the bot sleeps. That is a designed exception, not a metering bug.

## It does not join in

Work through this in order; stop as soon as one step explains it:

1. **Is the chat in scope?** A chat missing from `telegram.chats` is never processed, keyword or not.
2. **May it open a batch?** Outside active hours only `/ask`, a direct mention, a reply to one of the bot's own messages or a trigger keyword opens one; with `/ask`-only enabled, only `/ask`.
3. **Is the chat paused?** Administrator `/pause` keeps storing messages but starts no runs.
4. **Is the bot sleeping?** Overview shows the sleep state and the wake time.
5. **Did the entry gate drop it?** Under `enforce`, a rejected batch ends as `skipped_budget` with error code `decision_gate_dropped`.
6. **Did any invocation exist at all?** The tool session list answers this far more reliably than "nobody saw a reply in the group".

If all six pass, one explanation is left: the run happened and the model chose silence. That is where writing review comments (below) starts to pay off.

## It says odd things

- **Persona and per-chat rules.** The global persona lives in **Prompts** under the global scope; a chat's extra instructions live on the same page under *Chat <id>*. Prompt changes apply from the next run.
- **Model and thinking effort.** Switching models changes the voice; **Models** assigns roles and effort levels.
- **Send protection.** These are the "cannot say that" rules in the *Send behavior* group of **Harness tuning**: maximum text length, disallow blank lines, the empty-text strategy, the duplicate send guard, and allowing several replies to one message. A rejected send stays in the tool calls with an error code, which is faster than guessing.
- **Dictionary and memory.** Term explanations and past memories shape what it says. See [Manage memory and the dictionary](knowledge.md).

## Message batches: how long before the model sees a batch

Three fields decide how long a batch collects between its first message and the hand-over, all in seconds, all 0–300:

| Field | Panel label | Effect |
| --- | --- | --- |
| `telegram.bucket_window_seconds` | Minimum wait | The shortest collection. When a round ends, a batch still collecting restarts from here. |
| `telegram.bucket_bump_seconds` | Extension per message | Each message that could have opened the batch pushes settlement to at least its arrival plus this. `0` means no extension. |
| `telegram.bucket_max_seconds` | Maximum wait | Counted from the batch's first message, extension never goes past it. Defaults to the minimum wait when omitted. |

```jsonc
{
  "telegram": {
    "bucket_window_seconds": 5,
    "bucket_bump_seconds": 8,
    "bucket_max_seconds": 30
  }
}
```

The example above behaves like this: a lone message reaches the model after 5 seconds; while people keep talking, every message extends the wait to 8 seconds after itself, but never past 30 seconds from the first message, and anything later starts the next batch.

![The Message batches group on the Telegram settings page, with the three timing fields and the save button](__DOCS_BASE__/screenshots/tuning/bucket-timing.en.light.png)

Three rules are checked when you save:

- `bucket_max_seconds` must not be smaller than `bucket_window_seconds`.
- `agent.context.idle_grace_seconds` is either 0 (long-lived invocations off) or at least `bucket_max_seconds`. Raising the maximum wait to 60 seconds therefore requires the idle grace to be 0 or at least 60.
- `agent.context.max_wall_clock_seconds` must be larger than `idle_grace_seconds`.

Saving them in the *Message batches* group of the **Telegram** page applies immediately; hand edits apply when you press *Apply config file* in **Settings**. Neither needs a restart. New timings only affect batches that start collecting afterwards — a batch already collecting keeps the timing it opened with.

Only messages that could have triggered the bot extend a batch. Other bots, join/leave service messages and a sticker on its own (unless sticker triggering is enabled) join the batch without pushing it later.

## The entry gate (Decisions)

Before a finished batch is handed to the main model, a small decision model reads it and answers whether the bot would want to reply. The gate does not replace the persona: what to say is still the main model's job, and the gate only keeps obviously unnecessary batches away from it.

It is off by default, and while off the behaviour is exactly as if it did not exist. Once enabled there are two modes: `shadow` (*Record only* in the panel) records decisions without changing scheduling; `enforce` (*Enforce*) withholds a rejected batch.

![The Behaviour and Connection groups on the entry gate page](__DOCS_BASE__/screenshots/tuning/entry-gate.en.light.png)

### What it asks

The default question is a yes/no question with the batch and some earlier messages attached: as an ordinary group member, would the bot reply after reading this? The answer is a probability P, and the fixed rule is `P ≥ threshold` to hand the batch to the main model.

The request carries exactly one question, and the messages travel in `state`: `pending` is the new batch, `history` is older conversation. A custom question may use the `{{ bot.name }}` and `{{ bot.username }}` placeholders. It must still be a yes/no question whose "yes" means "hand this batch over" — after changing the question or the decision model, the default 0.57 has no basis any more, so observe in `shadow` again before setting a new threshold.

### Observe first, then enforce

1. Fill in `api_key` in the global `telegram.decision_gate`, turn `enabled` on and leave `mode` at `shadow`.
2. Run it for about a week so it accumulates decisions on real messages. `shadow` never makes the bot speak less.
3. Export the rows with `surowan-utils decision-gate decisions --chat <chat ID> --limit 50` and compare them with what the bot actually said in the same period: how many "do not hand over" verdicts should have been replies?
4. Only then switch `mode` to `enforce`, ideally on one chat first.

```jsonc
{
  "telegram": {
    "decision_gate": {
      "enabled": true,
      "mode": "shadow",
      "threshold": 0.57,
      "api_key": { "jar": "openrouter" }
    },
    "chats": [
      {
        "id": -1001234567890,
        "decision_gate": { "mode": "enforce" }
      }
    ]
  }
}
```

### What enforcement changes

- A rejected batch ends as `skipped_budget` with error code `decision_gate_dropped`. Its messages all stay, and they remain part of the history the model sees later.
- That chat **stops sampling proactive replies**. Proactive replies hand out chances with a pity counter, and a batch that is sampled in and then dropped would burn the counter for nothing; `shadow` does not change sampling.
- Decision tokens and cost are recorded on the decision row and stay outside the daily budget.
- Each decision is one row: mode, model, threshold, history and pending counts, `state`, `outcome`, `applied`, probability, tokens, cost, duration and error code. A `state` of `stale` means the verdict was discarded because the batch grew — not a failure.

### Batches that skip the gate

None of these send a decision request or write a row:

- The batch contains `/ask`, a direct mention, a reply to the bot's own message, or a trigger keyword. One is enough for the whole batch.
- Private chats: there is no group batch to judge, and configuring `decision_gate` on a private chat is rejected by `check-config`.
- Messages caught up after a restart, which arrived while the service was down.
- Runs that are not started by a group batch: notifications from background tasks (an alarm coming due, an image generation finishing), administrator recurring alarms, resuming a run from the panel, Playground release and retry.
- Chats that are paused, removed from the configuration, missing a complete model setting, or sleeping — none of these start a run in the first place.
- Chats in `/ask`-only mode: their only entry is a direct trigger, so no request is ever made.

### Every failure admits the batch

The gate exists to save money, not to withhold messages, so every error leans towards "hand it over":

- Timeouts, network errors, non-2xx replies, malformed responses and model refusals all admit the batch, and are not retried.
- A credential that cannot be resolved is recorded as `secret_unresolved` and also admits the batch.
- At most 4 decisions run at once; a batch above the limit is admitted immediately and recorded as `concurrency_limit` instead of queueing.
- If new messages arrive while the question is in flight, the verdict is discarded and the batch is asked again, at most twice. After that the batch simply enters — nothing is silently withheld.

### Credential and connectivity

`api_key` lives only in the global section and is an ordinary secret reference (`{ "jar": "<entry>" }`, `env` or `command`). It is resolved before every decision, so rotating the entry on the **Keychain** page applies to the next decision.

`enabled: true` — globally or through any chat override — requires the global `api_key` to be present. `check-config` only checks for the field, it does not resolve the reference, so a broken reference neither fails the load nor makes any noise: the gate quietly admits everything. Run `doctor` once after enabling it. With the gate on, `doctor` resolves the credential and sends one minimal request, fails loudly when that does not work, and never prints the value.

Every field (including `api_key`, `base_url` and `model`) applies from the next decision after you save. Per-chat overrides, the rule that private chats cannot configure one, and the per-field switches in the panel are covered in [Set boundaries per chat and topic](chats.md).

## Harness tuning: budgets and send protection

**Harness tuning** (`/harness`) edits the `agent` section of `config.jsonc` in five groups:

- **Budget and concurrency**: daily token budget, max concurrent invocations, history messages, context stop ratio.
- **Send behavior**: max text length, disallow blank lines, send reminder, wait for new messages, allow multiple replies to one message, duplicate send guard, empty-text strategy and fallback texts.
- **Rate limits**: sends per window, window length, turns per injection.
- **Context**: retained sends target and maximum, hard token ratio, reference TTL, idle grace, maximum wall-clock time, in-memory cache size.
- **Proactive replies**: the global defaults (below).

![The Budget and concurrency and Send behavior groups on the Harness tuning page](__DOCS_BASE__/screenshots/tuning/harness-budget.en.light.png)

Several values can change at once. *Save and apply* writes them back and applies, *Discard changes* restores the file's values, and only the fields you really changed are written — comments and formatting survive. Out-of-range values are flagged in place; rules that need more than one field (retained sends target below the maximum, idle grace covering the longest batch wait) are checked on the server, and a failure leaves the file untouched and explains why.

How it takes effect: the daily budget applies from the next model call, so lowering it constrains a run that is already going; every other field also applies as soon as you save — new history size applies to runs created afterwards, new rate limits to sends afterwards.

## Proactive reply chance

Proactive replies add a per-chat probability gate in front of ordinary group messages: only a sampled-in batch creates an invocation, and a consecutive-miss counter keeps the bot from never being picked.

Off by default. Once on, the chance on attempt *n* is:

```text
n >= hard_pity ? 100% : min(100%, base_probability + (n - 1) × increment)
```

With the defaults (`base_probability` 0.2, `increment` 0.1, `hard_pity` 8) that is 20%, 30%, 40% … and a guaranteed hit on attempt 8.

- **Exempt messages**: direct mentions, replies to the bot's own messages, trigger keywords, Telegram commands and `/ask`. Any direct cue lets the whole batch through, without increasing or resetting the counter.
- **Counters are per chat**, shared by all Forum Topics of that chat, and survive restarts.
- **Changing a parameter resets the counter**: when `base_probability`, `increment` or `hard_pity` changes, the next sample clears that chat's counter so old progress cannot trigger the guarantee immediately. Turning the feature off and on again, or restarting, does not.
- **A missed batch** still stores its messages; it just ends as `proactive_reply_skipped` without an invocation.

There are two places in the panel: global defaults in the *Proactive replies* group of **Harness tuning** (probabilities as 0–1), and per-chat overrides under *More actions* → *Edit proactive reply chance* on **Chats** (percentages). A chat can follow the global setting, turn proactive replies off, or use values of its own.

## Reviews: write down what went wrong

The invocation detail page and the **Reviews** page (`/reviews`) let you annotate the audit trail directly — "this line was too long", "it should not have replied here" — and export a Markdown prompt with full instructions for a local coding agent.

- **Browser-local only.** The draft is kept in this browser only; it is never uploaded to the server, so another browser or device will not show it. If the browser blocks local storage or runs out of space, the content survives only in the open tab.
- **What you can annotate.** The *Overview* tab lays a run out as a chat: each batch of messages starts with a *Messages queued* divider, members' messages sit on the left and the bot's on the right, and what the model did between two replies (the tools and skills it used, private assistant text, failed model calls) folds into one line you open to see each step. Hover a message or a step, or move to it with Tab, and *Add review comment* appears beside it; on a touch screen it is always shown. Each tool step opens its *Arguments* and its *Result* separately; the result is what the model actually received, so for a failed call it is the error the model saw. A bot reply opens its *Result* too. Successful model calls stay out of the chat: they are on the *Model calls* tab. The summary card takes one overall comment. Each comment holds up to 4,000 characters, and saving captures an excerpt of up to 280 characters from the event.
- **Cross-tab sync.** With several detail pages and the Reviews page open, a save, edit or delete in one tab reaches the others.
- **Two purposes.** *Tune this bot* writes for whoever runs this bot: the exported prompt asks the agent to trace each comment to the persona prompt, the chat prompt, harness settings, the model or the dictionary and memory, and to change things only after you approve each item. *Developer feedback* writes for Surowan developers: the agent must not touch the running configuration, only locate defects in the built-in system prompt, tool definitions or runtime behaviour and report them by impact.
- **Goal** (optional) is written into the prompt too. *Preview Markdown* shows the exact output before exporting, and expanding the preview does not clear the draft.
- **Exporting clears the draft.** Both *Download Markdown* (named like `surowan-review-20260101-120000.md`) and *Copy Markdown* ask for confirmation and then clear the draft. The panel cannot import an exported file again, so keep it somewhere.
- **The JSON tail.** The document ends with a `## Review data (JSON)` block, `format` `surowan.invocation-review`, `version` 1, a machine-readable copy of every comment for the agent to consume as structured input.

![The purpose selector and export confirmation dialog on the Reviews page](__DOCS_BASE__/screenshots/tuning/review-export.en.light.png)

How to hand that file to a local agent, and what it checks first, is in [Working with coding agents](agent-assisted.md).

## Resume a failed run

When a run ends as `failed`, `aborted` or `outcome_unknown`, the detail page offers *Resume*: it runs this conversation again for real, with the **current** configuration, so the bot may send messages and incur charges.

Resume is available only when (`resume_*` error codes otherwise, and the button is not shown):

- it is the **latest** invocation of that conversation — a resume continues from the canonical context, which only equals "run that batch again" while nothing else happened since;
- no invocation is queued or running in the conversation;
- the chat is still configured, not paused, the topic still allowed, and the model settings complete;
- the bot is not sleeping, and Telegram is connected;
- it is not a Playground room, which retries through its own release ledger.

A resume never makes the model read the same batch twice: if the failed batch already reached the conversation context, the new run simply continues from there and is told it is a resume; if it never got in, that batch is handed to the model again as it was.

Resume really spends money and really may send, so for API-key callers it is `write+paid`: only a key in `all` mode can call it. Replay is a different tool — it produces no Telegram side effects, see [Invocation preflight and replay](../developer/replay.md).

![A failed run's detail page with the Resume button and the auto-refresh controls](__DOCS_BASE__/screenshots/tuning/invocation-resume.en.light.png)

## Compare results with evidence

After each change, compare the same kind of evidence instead of checking that saving succeeded:

- **Tool sessions**: invocation count, send count, tokens and cost for comparable batches. Filtering by chat and model makes a single changed knob visible.
- **Entry gate rows**: `surowan-utils decision-gate decisions` gives `outcome`, `probability`, `threshold` and error codes, which tells "withheld" apart from "never asked".
- **Overview daily usage**: token and invocation trends over 7 or 30 days. After lowering the budget, confirm the bot did not go quiet for hours because it slept.
- **Review comments**: writing down what was wrong is more reliable than remembering it, and an agent receives exactly the same facts.

Configuration drift is a different kind of evidence: the *Config file* group on **Settings** shows the active hash, the file hash, and whether the file matches the running configuration; *Last error* explains a failed apply. Which fields only apply after a restart is in [Configuration lifecycle](../configuration/lifecycle.md).
