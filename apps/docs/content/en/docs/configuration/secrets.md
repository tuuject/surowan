---
title: Secrets and paths
description: The three SecretRef forms, the key.json keychain beside the configuration, rotation and orphan purging, what a failed resolution looks like, file permissions and path bases.
---

# Secrets and paths

The configuration file can be read, diffed, pasted into a chat or handed to an agent for review, because it contains **no plaintext secrets** — only references to them. This page covers the three reference forms, where the values live, what happens when resolution fails, and which base each path resolves against.

## The three SecretRef forms

A field that needs a secret accepts exactly one of these objects; a string is rejected:

```jsonc
{
  "telegram": {
    // 1. Environment variable, injected by Compose, a supervisor or the shell
    "token": { "env": "TELEGRAM_BOT_TOKEN" }
  }
}
```

```jsonc
{
  "providers": {
    "gateway": {
      // 2. Keychain: the value lives in key.json next to the file; this is only a name
      "headers": { "X-Routing-Key": { "jar": "gateway-routing" } }
    }
  }
}
```

```jsonc
{
  "web_search": {
    "engines": [
      // 3. External command: no shell, only the fixed argv written here
      {
        "id": "main",
        "provider": "tavily",
        "api_key": { "command": ["secret-tool", "lookup", "service", "surowan"] }
      }
    ]
  }
}
```

| Form | Value comes from | Notes |
| --- | --- | --- |
| `{ "jar": "<name>" }` | `key.json` in the configuration's directory | The name is 1–64 letters, digits, `_` or `-`. |
| `{ "env": "<NAME>" }` | Process environment | `.env.local` and `.env` in the current working directory are loaded by every CLI subcommand. |
| `{ "command": ["<argv>", …] }` | The command's standard output | No shell; only the argv written in the file runs. |

Fields that accept a SecretRef: `telegram.token`, `telegram.decision_gate.api_key`, `providers[].api_key` and `providers[].headers`, `mcp.servers[].env` and `headers`, `web_search.engines[].api_key`, `image.credentials`.

The `command` boundary: at most 5 seconds, at most 4096 bytes of standard output with one trailing newline removed, and a minimal inherited environment (`PATH`, `HOME`/`USERPROFILE`, `TEMP`, locale variables and a few more). Every step can fail, so it suits a local tool such as `secret-tool`, not a slow network call.

## key.json and the keychain

`key.json` is the named secret store beside the configuration. One directory's `key.json` belongs to that directory's `config.jsonc` only. Its format is versioned:

```json
{
  "version": 1,
  "entries": {
    "telegram": { "value": "…", "created_at": "2026-01-01T00:00:00.000Z" }
  }
}
```

(That is the shape, not a real value; entry values are never shown anywhere.)

- **The name is the identity.** `{ "jar": "telegram" }` points at that entry; renaming it is switching entries. One entry can be referenced from several places, so a single key can serve the Telegram token, a provider and an MCP server.
- **Rotation happens in place.** Pressing **Rotate** on the panel's Keychain page — or submitting a new value into a secret field whose entry only that field uses — replaces the value and keeps `created_at`. Rotation immediately runs an apply: providers using it rebuild their connection, referenced MCP servers reconnect, Telegram re-reads the token, image credentials are re-resolved. No restart is involved; see [configuration lifecycle](lifecycle.md).
- **Orphans are removed by hand.** Writing the configuration never deletes entries that lost their last reference. The Keychain page lists entries referenced by neither the file nor the running configuration as **Unused**, and **Purge orphans** deletes them; deleting a single entry that is still referenced is refused. When the configuration cannot be parsed, both actions are refused instead of deleting based on an incomplete reference set.
- **The old format migrates automatically.** The previous flat `{ "<name>": "<value>" }` file is migrated in place at startup of `serve`, `doctor` and `configure`, keeping every name. Other read paths refuse the old format and tell you to run one of those first. Migration is one-way: an older build cannot read the migrated file.
- **Writes are atomic.** `key.json` is written to a temporary file and renamed, so a reader sees either the old file or the complete new one; symlinks are refused.

## File versus panel input

The configuration file only ever holds references. The panel's secret field offers three sources: **Enter a new key**, **Use an existing entry**, and a read-only **External reference** showing the current `env` or `command`.

Choosing "Enter a new key":

- The plaintext goes to the server only, is written into `key.json`, and the file gains a `{ "jar": "…" }` reference. The entry name is prefilled from where the field sits (provider alias, `telegram`, `search-<engine id>`, image credential name); a collision becomes `-2`, `-3` and so on.
- If the entry that field currently points at is used nowhere else, the value is rotated on that entry and the file does not change. If it is shared, a new entry is created and this one field is repointed — the other uses are never silently changed.

The panel never shows an entry's value: the Keychain page lists names, creation times and where each entry is used.

## What a failed resolution looks like

SecretRefs are resolved only when they are needed, so failures show up per use instead of blocking startup:

| Where | What happens |
| --- | --- |
| Provider `api_key` / `headers` | The apply fails with `secret_unresolved`; the running snapshot keeps the old configuration. Fix the reference or the entry and apply again. |
| MCP server `env` / `headers` | That server is published as `degraded` and retried in the background; its tools are withheld until it recovers. |
| `telegram.token` | The connection state becomes a configuration error with reason `token_unreadable`; the process keeps running and the panel and Playground remain available. |
| `web_search.engines[].api_key` | That search call returns `secret_unresolved`; other engines and tools are unaffected. |
| `telegram.decision_gate.api_key` | The decision row records `secret_unresolved` and the batch is admitted, because a failed decision always admits. |
| `image.credentials` | The apply fails because the image snapshot cannot be prepared, and the previous image configuration stays active. At process startup it only logs `image_service_warning` and continues. |

One special case: a `telegram.token` that resolves to an **empty string** is not an error — it means "Telegram disabled", exactly like omitting `token`.

`check-config` validates the file's shape and cross-field rules only. It resolves **no** SecretRef and never runs a `command`. Use `doctor` and the panel's health checks for real availability.

## Permissions

On non-Windows systems:

- The configuration file must be `0600` and its parent directory `0700`. `serve`, `doctor` and every panel or command write enforce this; `check-config` does not.
- `key.json` must be `0600`, otherwise reading fails. The Docker image entrypoint corrects both.
- `serve` creates a missing data directory as `0700`; the permissions of an existing one are only checked by `doctor`.

These checks are skipped on Windows.

## Path bases

The two kinds of path resolve against different bases, which is easy to get wrong:

| Path | Resolved against |
| --- | --- |
| `agent.system_prompt_file`, `telegram.chats[].instructions_file` | **The configuration file's directory** |
| `key.json` | The configuration file's directory; not configurable |
| `data_dir`, `paths.database`, `paths.media_cache`, `paths.backups` | **The process working directory** (`/app` in the Docker image) |

So a Compose deployment writes container-absolute paths for data (`/data/…`) and keeps prompt files and `key.json` in `/config`. See [install and sign in](../guides/installation.md).

HTML comments (`<!-- … -->`) inside prompt files are stripped before the text reaches the model; the configuration hash still covers the raw bytes, so a comment-only edit changes `config_hash` too.

## Security boundaries

- Never commit, upload or publish secrets: there are none in `config.jsonc`, and `key.json` is the file to protect.
- Secrets are redacted in errors: resolved values and values just submitted by the panel are replaced with `[REDACTED]` before an error message, log line or API response is written. Values shorter than 6 characters are not redacted, because at that length they would mask ordinary words without protecting anything.
- The repository's `.claude/settings.json` denies `Read(**/key.json)` so Claude Code cannot read the keychain. That is one tool's guard rail and binds no other agent or process: never hand `key.json` to an agent.
