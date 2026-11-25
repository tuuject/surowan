---
title: Scheduled tasks and recurring alarms
description: Tell the bot's one-off alarms apart from admin-defined recurring alarms, configure rule or cron schedules, time zones and run history.
---

# Scheduled tasks and recurring alarms

Scheduled work in Surowan comes in two distinct forms — do not confuse them:

| | Alarm | Recurring alarm |
| --- | --- | --- |
| Created by | Someone in the chat asking the bot to remind them | An admin in the panel |
| Schedule | Once, at a specific moment | Repeated by rules or cron |
| Prompt | The user's own words | A trusted prompt written by the admin |
| Can the bot change it | Yes (`alarm` / `list_alarm` / `delete_alarm`) | No, and it cannot even see the panel title |
| Panel page | **Alarms**, read-only audit | **Recurring alarms** |

## One-off alarms

An alarm is stored durably and survives a restart. When it comes due: if the bot is already running in that conversation, the alarm is handed to it once its current step finishes; otherwise a new run starts when one can. The model decides on the spot whether and what to say; nothing is pre-written. Each invocation may create at most 3 alarms.

You can inspect pending, fired or cancelled alarms under **Data → Alarms**, and cancel pending ones manually.

## Recurring alarms

Recurring alarms make the bot act on a timetable: greeting the group at 08:00, or posting a short brief at 18:00. Each one has four parts: which conversation to post in, when to fire, which time zone, and the prompt handed to the bot.

Only admins can create or change them, on the **Data → Recurring alarms** page. Group members cannot request them, and the bot can neither create, read nor delete them.

### Creating one

![The recurring alarm dialog with rules, cron and the next five runs](__DOCS_BASE__/screenshots/tools/recurring-alarm.en.light.png)

1. Choose **New recurring alarm**.
2. Fill in the **Title**. It is only shown in the panel; the bot never sees it.
3. Pick a **Target**: a configured Chat the bot has already seen (a Chat with a Topic allowlist is listed per Topic), or a Playground room, so you can test without disturbing a real group. Targets that cannot receive messages right now are marked with the reason and cannot be selected. **A saved alarm keeps its target**; create a new one to change it.
4. Set the **Time zone** (an IANA name such as `Asia/Shanghai`); a new alarm starts from the global time zone. Each alarm remembers its own zone, so later changes to the global zone never move an existing "8 a.m.".
5. Write the **Prompt**, up to 4000 characters. It is a trusted instruction from you: the bot carries it out as if you had asked in the chat, but it still only has the tools it already had. The prompt never grants new permissions.
6. Decide whether it is **Enabled**, then create it.

Each conversation holds at most 20 recurring alarms. A Chat with a Topic allowlist counts per Topic, and each Playground room counts separately.

### The schedule

A schedule has two views of the same rules:

- **Rules**: five fields — minute, hour, day, month, weekday — each set to "every" or "at". An empty "every" fires on every unit, a number fires every N units; "at" takes explicit values, comma separated, so `0,30` in minutes means on the hour and on the half hour. Weekdays are checkboxes.
- **Cron**: one standard five-field expression per line, `minute hour day month weekday`. `0 8 * * *` is 08:00 daily, `30 9 * * 1-5` is 09:30 on weekdays, and weekday `0` is Sunday.

Details:

- Several rules add up: the alarm fires whenever any rule matches.
- When one rule restricts both day and weekday, either may match — the usual cron behaviour.
- Seconds and years are not supported, nor are `L`, `W`, `#` or `?`.
- Once a line uses syntax the rule builder cannot represent (a range such as `1-5`), keep editing it as cron.
- Editing shows **Next runs**, the next five occurrences in the chosen zone. Two runs less than 5 minutes apart raise a warning that does not block saving.

### What happens when it fires

- If the bot is already running in that conversation, the task is handed over once its current step finishes; otherwise a new run starts.
- It **does not consume the daily token budget** and runs even while the bot is in its sleep window. Playground rooms behave the same way.
- The model receives your prompt together with the planned time and how many missed occurrences were folded in (in a run's frozen context it is the `<admin_scheduled_task>` block).
- As always, a message only appears in the chat if the model actually calls the send tool.

An occurrence is skipped — the alarm stays and fires again next time — when:

- The service was down or disconnected and recovery came more than 30 minutes after the planned time. If it is less late, the occurrences missed meanwhile are coalesced into a single delivery, whose count is recorded.
- The target Chat is paused or removed from the configuration, its Topic is no longer allowlisted, or the agent identity is incomplete.
- The previous occurrence has not been delivered yet.

### Running once, editing, deleting

- **Run now** on a row executes the saved prompt immediately, which is useful while tuning it. It behaves exactly like a scheduled run and the bot sees the same content; it does not change the schedule and works even while the alarm is disabled. It is refused while a previous run is still undelivered.
- Editing the schedule or time zone recomputes the next run from now; editing only the prompt affects later runs. The row switch disables and enables an alarm: a disabled alarm keeps its schedule but never fires, and an occurrence that has not started delivering is cancelled.
- Deleting removes the schedule and its run history, and also cancels an undelivered occurrence.
- **Details** shows the **Recent runs**: planned time, source (Scheduled or Manual), result, who ran it, and the invocation that handled it.

### Managing it with an API key

API keys can manage recurring alarms too (`surowan-utils`' `recurring-alarm` commands, or MCP tools). Listing and previewing need read access; creating, editing and running now make the bot call a model unattended, so they need both write and paid-operation permission; deleting needs write access.

## Common mistakes

- A recurring alarm is not the bot's one-off alarm, and group members cannot create one. A trusted prompt does not widen tool permissions.

Related pages: [Try personas and tools in the Playground](playground.md), [Working with coding agents](agent-assisted.md), [Set boundaries per chat and topic](chats.md), [Troubleshoot startup failures and silence](troubleshooting.md).
