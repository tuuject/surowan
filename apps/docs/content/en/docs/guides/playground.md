---
title: Try personas and tools in the Playground
description: Create a room, hold messages, release them into a real run, and tell replies, deliberate silence and failures apart — plus what does not apply in a room.
---

# Try personas and tools in the Playground

The Playground is the panel's built-in sandbox. What you type in a room goes through the same scheduler, runtime and model configuration as a real chat, but every output stays in the room and never reaches Telegram. It is the place to try a persona, watch replies and find out whether the model speaks at all, without touching a real chat.

A room is not a mock: releasing messages really calls the model, and really costs money. If you want to save spend, do not release.

## 1. Rooms and identities

1. **Playground → New room**, give it a name, and optionally a few **initial identities** (comma separated). A new room holds messages and has image generation off.
2. Each room has its own identity list; names may repeat, which is how you simulate two people with the same name. Identities are members or admins, which only changes the label — it grants no command permissions.
3. Below the timeline, pick a sender in **Sending as**, write a message and choose **Send**. You can reply to a specific message; the model sees the same quote relationship as in a real chat.

A message can carry up to four images, 10 MiB each, JPEG / PNG / WebP only.

## 2. Hold and release

Rooms have no "send and it runs" mode: new messages wait in the hold queue and start no model call.

- **Release N**: seals the pending messages into one batch and queues exactly one real run for it. With nothing pending, releasing only turns the hold off and runs nothing.
- **Hold new messages**: turns the hold back on, so later input queues again.
- Input is admitted in arrival order; a room runs one invocation at a time, and a later batch waits for the one in flight.
- The room header shows the revision, the hold state and how many messages wait; `queued` and `running` below it count the queue and the active run.

![The Playground with messages held and not yet run](__DOCS_BASE__/screenshots/playground/hold-pending.en.light.png)

## 3. Read the timeline and the runs

Every timeline message carries a state badge: **Held**, **Released**, **Succeeded**, **Failed**, **Expired**. The bot's output appears as room messages, and a reply names the sequence it answers.

The **Runs** list records each release: `queued`, `running`, `completed`, `failed`, `aborted`, `outcome unknown`, with token usage, cost and an **Audit** link. Audit opens the same invocation detail page a Telegram chat uses, showing tool calls, model requests, room sends and the frozen context.

Three outcomes are different things:

- **A reply**: the bot's message appears in the timeline and the run is usually `completed`.
- **Deliberate silence**: the run ends but says it finished without posting anything. That is the model's decision, not a failure.
- **A failure or abort**: expand the run for the error. `Outcome unknown` means a process interruption left the result unclear — check the timeline and audit before retrying blindly.

![After a release: room output, run state and the audit entry](__DOCS_BASE__/screenshots/playground/release-result.en.light.png)

## 4. Retry, and how it differs from Resume

A failed or aborted run offers **Retry this run**, on narrow conditions:

- Only `failed` or `aborted` attempts can be retried; `outcome unknown`, completed and queued ones are refused.
- That attempt must have had **zero side effects**: no message sent, no tool call, no model call and no injected context.
- It is refused when the room already has a later release, so the order cannot be scrambled.

The page states the reason when a retry is refused. A failed run in a real chat is a different mechanism: **Resume** in the invocation detail continues the latest failed run of one conversation (including an aborted one or one with an unknown outcome). Do not mix them up — a room retry means "this attempt never started", while Resume means "this attempt really ran, and continues from where it stopped".

## 5. The image generation cost boundary

Each room has its own **Image generation** switch, off by default. Turning it on lets that room's model call the image service for real, **which costs money**; the page records who turned it on and when.

- The switch does not check the global image configuration: with no valid `image` section, turning it on still produces no images.
- Turning it off only blocks new submissions; generations already accepted finish and their receipts still return to the room.
- It has nothing to do with cost outside the room; the image setup itself is in [Images, stickers and image generation](images.md).

## 6. A trial target for recurring alarms

The **Recurring alarms** target list includes every Playground room (shown as `Room: <name>`). To check what a periodic prompt does without letting it speak in a real group on the first try, point the alarm at a room, watch a few firings, then move it to a real chat.

Rules, cron and Run now are in [Search, scheduled tasks and external tools](tools.md); a saved alarm's target cannot change, so a different target means a new alarm.

## 7. What does not apply in a room

A room runs a deliberately narrowed profile, separate from Telegram's:

- **No entry gate**: its settings come from `telegram.*`; rooms are unaffected and produce no gate decisions.
- **No active hours, `/ask`-only or proactive-reply sampling**: those are Telegram participation settings.
- **No stickers, alarms, dictionary writes or MCP tools**: the room's skill list omits them.
- A room has its own Memo entries and image assets, isolated from every Telegram chat; deleting the room deletes them.
- Room model usage goes into the separate `playground` usage scope, so it does not consume a Telegram chat's daily budget, while the same configured limits still apply.

Room messages, runs and audit data follow `retention.online_days`; local image assets are kept through backups. Details are in [Upgrade, back up and restore](maintenance.md), [Data paths and retention](../configuration/storage.md) and the [`retention` field reference](../configuration/fields-retention.md).

## 8. Common misunderstandings

- **A room is not a mock**: releasing is a real model call, billed like a real chat.
- **Hold is not pause**: it only parks new input; it does not cancel a queued run or stop a generation already started.
- **"Outcome unknown" is not a failure**: an interruption during a send may have left real side effects; check before deciding.
- **A room is not a group**: its identities never appear in a real chat, and no @, topic or sticker happens here.
