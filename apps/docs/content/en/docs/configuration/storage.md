---
title: Data paths and retention
description: data_dir, timezone, database/cache/backup paths, the three retention fields, when serve and backup clean up, what is cleaned and what never is.
---

# Data paths and retention

This page covers four required parts of the file: the root scalars `data_dir` and `timezone`, the `paths` section, the `retention` section, and the cleanup and backup behaviour behind them.

```jsonc
{
  "version": 1,
  "data_dir": "/data",
  "timezone": "Asia/Shanghai",
  "paths": {
    "database": "/data/surowan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups"
  },
  "retention": {
    "online_days": 30,
    "backup_copies": 7
  }
}
```

## Root scalars

| Field | Meaning |
| --- | --- |
| `version` | Required; the only accepted value is `1`. |
| `data_dir` | Required. The base directory for image archives and asset data: `<data_dir>/images` holds generated originals, with `playground/` (room assets) and `memo-blobs/` (Memo images) beside them. |
| `timezone` | Required, an IANA name such as `Asia/Shanghai`, validated with `Intl` when the file loads. Used whenever a chat has no `timezone` of its own, which affects active hours, the day boundaries of group memory, the default zone of recurring alarms, the timezone variable in the prompt, and time display in the panel. |

Paths resolve against the **process working directory**, not the configuration file's directory. Containers normally use absolute paths like `/data`; a relative path works but depends on where the process was started.

## paths

| Field | Meaning |
| --- | --- |
| `paths.database` | The SQLite file. A missing parent directory is created with `0700`, and on non-Windows systems the file itself is `chmod 0600`. |
| `paths.media_cache` | Scratch space for image conversion: a temporary subdirectory is created when media needs transcoding and removed afterwards. Safe to empty while the service is stopped. |
| `paths.backups` | Where the `backup` command writes; created with `0700` when missing. |

Prompt files (`agent.system_prompt_file`, `chats[].instructions_file`) are the exception: they resolve relative to the configuration file's directory. See [Secrets and paths](secrets.md).

## retention

| Field | Meaning |
| --- | --- |
| `retention.online_days` | Required, positive integer. How many days of audit and scheduling data stay online. |
| `retention.backup_copies` | Required, positive integer. How many backup files `backup` keeps. |
| `retention.warning_read_days` | Optional, positive integer, default 30. How long an event warning is kept after it was marked read. |

### How each field takes effect

| Field | Applies |
| --- | --- |
| `data_dir`, `timezone`, `paths.database`, `paths.media_cache` | on restart |
| `retention.online_days` | hot — the next cleanup (at most 24 hours later) uses the new value |
| `retention.warning_read_days` | on restart |
| `paths.backups`, `retention.backup_copies` | not used by the running service; the next `backup` reads them |

## When cleanup runs

Retention cleanup has exactly two triggers:

1. **`serve`**: once at startup (before the scheduler may launch work, so the first boot after an upgrade can absorb a large backlog quietly), then every 24 hours. Every run reads the current `retention.online_days`, so a hot-applied value reaches the next run. A failed run logs `retention_cleanup_failed` and the timer keeps going; the process stays up.
2. **`backup`**: the same purge runs before the SQLite copy is taken, so a backup never carries audit data that is already past the window.

Event warnings have their own hourly sweep that deletes only rows that are **read and older than `warning_read_days`**; unread warnings never vanish on their own.

### What gets cleaned

Past `online_days`:

- finished Invocations (`completed`, `failed`, `aborted`, `outcome_unknown`, `skipped_budget`) and, by cascade, their agent transcripts, model calls, tool calls and send records; running or queued rows, and rows a live resume still needs, are left alone;
- buckets (including merged and expired ones) and sender rows nothing references any more;
- the background image-analysis cache, model calls that belong to no Invocation, and group-memory consolidation runs;
- finished long tasks whose receipt was handled, historical recurring-alarm firings, and old `daily_usage` dates.

A few other rows are cleaned on their own deadlines or windows:

- Memo entries (deleted when `expires_at` passes, independent of the retention window), `conversation_attention`, `context_refs`, plus expired nonces and sessions;
- one-time pairing codes that were used, cancelled or expired — these still wait out the retention window before they go;
- Playground inputs still held for a message older than the window (marked `expired`; the request key stays as a tombstone).

### What neither window ever removes

- **Chat messages, message revisions, Media rows and Conversation Context.** They disappear only when the Chat or Conversation is deleted, or the context is truncated explicitly.
- **Raw Telegram Updates.** They stay in the database too.
- Chat configuration, dictionary entries, Memo bodies (unless expired), API keys and paired clients: identity and user data, removed only on explicit delete.

## Images in a backup

`backup` produces a **pair**:

```text
<paths.backups>/surowan-<timestamp>-<uuid>.sqlite
<paths.backups>/surowan-<timestamp>-<uuid>.images/     ← a copy of <data_dir>/images
```

- The `.images` directory is the backup file name with `.sqlite` replaced by `.images`. A missing `<data_dir>/images` is skipped, and a failed copy is logged without invalidating the SQLite backup.
- There is no cross-store atomicity: rows committed after the SQLite snapshot may reference image files copied before or after that point. Restore by putting `.images` back at `<data_dir>/images`.
- Rotation keeps the newest `retention.backup_copies` `.sqlite` files by modification time and deletes the `.images/` directories of the copies it removes. The automatic `pre-migration-*.sqlite` copies rotate only among themselves at upgrade time, but a later `backup` rotation does not filter by name, so old pre-migration copies can be cleared too.
- The configuration file, prompts and secrets are **not** in the database and need their own backup.

Full backup and restore steps, including an isolated rehearsal: [Upgrade, back up and restore](../guides/maintenance.md).

## Example

Three months of audit, the three most recent backups, default warning retention:

```jsonc
{
  "retention": {
    "online_days": 90,
    "backup_copies": 3
  }
}
```

## Interactions

- The configuration file's own permissions (`0600` / parent `0700`): [Secrets and paths](secrets.md).
- `history_messages`, context trimming and GC are a different mechanism: [Agent settings](agent.md).
- The **Settings** page shows the active hash and the "restart required" list: [Configuration lifecycle](lifecycle.md).

Types and ranges: [Retention field reference](fields-retention.md) and [Paths field reference](fields-paths.md); the scalars `data_dir`, `timezone` and `version` are in the [configuration field reference](fields.md).
