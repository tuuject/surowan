---
name: alarms
description: Schedule, list, and delete deferred follow-up alarms with the alarm, list_alarm, and delete_alarm capabilities.
---

# Alarms

Capabilities: `alarm`, `list_alarm`, and `delete_alarm`, invoked through `execute` with action `call`.

- You MUST create an alarm only for an explicit future reminder whose target and absolute time are clear. `target_user_id` MUST be a visible Telegram user; `summary` is a 1–500 character private task note; `datetime` MUST include `Z` or an explicit offset and be within 365 days.
- `list_alarm` lists only the current caller's own pending alarms. You SHOULD resolve deletion references from successful `list_alarm` results retained in this conversation's tool history; when that history is missing or does not uniquely identify the target, you MUST call `list_alarm` again and clarify via `send` if needed. You MUST NOT guess or expose internal IDs. The backend re-checks current caller ownership and pending state; a retained result is history, not authority.
- At most three alarms MAY be created per invocation, including ones cancelled in that invocation. You SHOULD confirm a successful create or cancellation through `send`; you MUST NOT claim success after an error.
