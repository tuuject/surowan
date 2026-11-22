---
title: Debug recording settings
description: The two developer switches, their defaults, what each records, how the bulk clear behaves and how far the scope reaches.
---

# Debug recording settings

The `developer` section holds two switches that record extra detail while you investigate a problem. They are independent, both optional, and off when omitted.

```jsonc
{
  "developer": {
    "record_model_payloads": true,
    "record_agent_thinking": true
  }
}
```

## Fields

| Field | Default | What it records |
| --- | --- | --- |
| `record_model_payloads` | `false` | The raw request payload of every model call plus the HTTP response status. Inline image bytes inside the payload are replaced by a summary; the bytes are never stored. |
| `record_agent_thinking` | `false` | The assistant message's thinking text (CoT), kept apart from the reply text and expandable in the transcript and the timeline. |

Both switches only affect **later** records: calls made before you enabled them have nothing to backfill, and turning them off keeps what is already stored — nothing is deleted automatically.

Turning them off never loses the regular audit trail: Invocations, model and tool calls, token and cache usage, cost, states and errors are recorded either way.

## How it takes effect

The section is hot, and both values are read at the moment they are used:

- `record_model_payloads` is read before each model call;
- `record_agent_thinking` is read when each assistant message is stored.

So the next model call and the next assistant reply after the apply follow the new value — no restart, and no rewriting of records already written. If the panel shows that the file setting differs from the running state, the configuration has not been applied yet; use **Apply config file** on the **Settings** page.

## Bulk clear

**Clear payloads** on the panel's **Developer** page deletes the saved model request and response snapshots (`DELETE /api/developer/model-payloads`):

- only the `request_json` / `response_json` columns are cleared; the model call rows, their relations, usage and statistics stay;
- the sweep works in batches of 100 and yields the write lock between batches, so the bot never stalls for long; if it fails midway the completed batches stay committed and you can run it again;
- the range is bounded by the highest call id at the moment it starts, so payloads recorded while it runs are not swallowed;
- affected invocations can **no longer be replayed**, because their raw payloads are gone;
- if a switch is still on, new payloads keep being recorded.

The clear does not run `VACUUM`; the database file does not necessarily shrink immediately, and the freed pages get reused by later writes.

## Scope

Both switches are global: every chat, both hosts (Telegram and the Playground) and every model. There is no per-chat version, and the payloads never enter a Conversation Context — they are audit data that only appears in the panel's tool session detail.

Thinking text stored by `record_agent_thinking` belongs to its Invocation's agent transcript and is pruned with that Invocation under `retention.online_days` (see [Data paths and retention](storage.md)).

## Example

Turn it on to reproduce one strange problem, then turn it off again:

```jsonc
{
  "developer": {
    "record_model_payloads": true
  }
}
```

This enables payload recording only; `record_agent_thinking` keeps its default, off.

## Interactions

- The lower half of the panel's **Developer** page edits `models_dev.api_url`, which is not part of this section; see [Model metadata catalog](models-dev.md).
- Payloads add noticeable database size; capacity and backup size are covered in [Data paths and retention](storage.md).
- How replay uses these payloads: [Invocation preflight and replay](../developer/replay.md).

Types: [Debug recording field reference](fields-developer.md).
