---
title: Configuration file basics
description: Where the configuration file lives, what strict JSONC accepts, which sections are required, how to check it, and where to start.
---

# Configuration file basics

This page is about the file itself: where it lives, what format it uses, which sections are required, how to validate it and what to download. For the exact type and default of a field see the [configuration field reference](fields.md); for when a change takes effect see [configuration lifecycle](lifecycle.md).

Every panel save — Providers, Models, Prompts, Chats, Harness tuning, Telegram, Developer — writes this file. Hand-editing it is the other way in, and the two do not conflict.

## Where the file lives

Every CLI subcommand needs an explicit `--config <path>`. There is no default path and no upward search:

```bash
node src/cli.ts serve --config /path/to/config.jsonc
```

The Docker template mounts the host's `./config` at `/config`, so inside the container the configuration is `/config/config.jsonc`, with `key.json` and the prompt files in the same directory.

- The configuration hash is the SHA-256 of the file's raw bytes plus the content of every prompt file. `check-config`, the `serve_started` log entry and the audit rows all print that same value.
- Hand edits are never picked up automatically: there is no file watcher. Either press **Apply config file** on the panel's Settings page or restart the process, as described in [configuration lifecycle](lifecycle.md).
- On non-Windows systems `serve`, `doctor` and every panel write require the configuration file to be `0600` and its parent directory `0700`. `check-config` validates content only and does not look at permissions.

## Strict JSONC

The file is JSON with comments: `//` and `/* */` comments, trailing commas and a UTF-8 BOM are accepted. Beyond that it is strict:

- **Unknown fields are rejected**, not ignored. Every object is closed (`additionalProperties: false`), so a typo such as `bucket_windows_seconds` fails with the offending key names listed.
- **`version` must be `1`.**
- **Plaintext secrets are not accepted.** `telegram.token`, `providers[].api_key` and `headers`, `mcp.servers[].env` and `headers`, `web_search.engines[].api_key`, `image.credentials` and `telegram.decision_gate.api_key` only take a SecretRef; a string there is rejected with its field path. See [secrets and paths](secrets.md).
- **`image` is the one soft-validated section.** A structurally invalid block is stripped, image generation is treated as disabled and a warning is recorded; the rest of the process still starts. No other section degrades like that.

## Required sections and a minimal file

Only these root fields are required:

- `version` (`1`), `data_dir`, `timezone`.
- `providers`: an empty object `{}` is fine; models can be added later in the panel.
- `retention`: `online_days`, `backup_copies`.
- `paths`: `database`, `media_cache`, `backups`.
- `admin`: the whole section is required; `host`, `port` and `session_ttl_hours` are required, `enabled` may be omitted (it defaults to `true`).

Every other top-level section is optional and means "feature off" or "use the defaults". Telegram may be absent entirely; when the section exists, its `process_bot_messages`, `bucket_window_seconds` and `chats` are required, while `token` still may be omitted (an absent token disables Telegram).

The smallest configuration that runs (Admin Panel only, no Telegram, models added later in the panel):

```jsonc
{
  "version": 1,
  "data_dir": "/data",
  "timezone": "Asia/Shanghai",
  "providers": {},
  "retention": { "online_days": 30, "backup_copies": 7 },
  "paths": {
    "database": "/data/surowan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups"
  },
  "admin": { "host": "127.0.0.1", "port": 8787, "session_ttl_hours": 24 }
}
```

`serve` starts on this file: the panel and Playground rooms work, and because no agent model is configured the bot never runs. First sign-in is covered in [install and sign in](../guides/installation.md).

[Download the minimal example](__DOCS_BASE__/examples/config.minimal.example.jsonc). For Telegram, providers, vision and image generation see the [full example](__DOCS_BASE__/examples/config.example.jsonc).

## Every top-level section

A section with child fields has its own generated `fields-<section>.md` page, and each hand-written page below links to it.

| Section | Required | What it holds |
| --- | --- | --- |
| `version` | yes | Only `1` is accepted. |
| `data_dir` | yes | Root for the serve lock and runtime data. [Data paths and retention](storage.md) |
| `timezone` | yes | Default IANA timezone; a Chat may override it. [Field reference](fields.md) |
| `telegram` | no | Token, batch timing, Chats and Topics, participation, entry gate, sticker sets. [Telegram settings](telegram.md) |
| `providers` | yes | Providers and the models you explicitly enable. [Providers and models](providers.md) |
| `agent` | no | Main model, prompt, budget, sending and Context policy. [Agent settings](agent.md) |
| `vision` | no | Image and sticker analysis model. [Vision settings](vision.md) |
| `tool_model` | no | System-wide helper model; inherits the global agent when omitted. [Tool model settings](tool-model.md) |
| `models_dev` | no | Catalog address used when models are added in the panel. [Model metadata catalog](models-dev.md) |
| `image` | no | Image generation credentials and models. [Image generation settings](image.md) |
| `dictionary` | no | Dictionary injection mode. [Dictionary settings](dictionary.md) |
| `web_search` | no | Built-in web search. [Web search settings](web-search.md) |
| `web_fetch` | no | Address and format switches for page fetching. [Web fetch settings](web-fetch.md) |
| `mcp` | no | External MCP servers the bot calls. [External MCP settings](mcp.md) |
| `admin` | yes | Admin Panel listener and session lifetime. [Admin Panel service settings](admin.md) |
| `developer` | no | Debug payload and thinking recording. [Debug recording settings](developer.md) |
| `retention` | yes | Audit and scheduling retention, backup copies, read-warning retention. [Data paths and retention](storage.md) |
| `paths` | yes | SQLite, media cache and backup directories. [Data paths and retention](storage.md) |

## Examples are not defaults

Real defaults come from two places — the `default` annotated on the Schema (printed as a **schema default**; a convention for people and tools that the loader never writes into the file) and constants in the runtime (printed as a **runtime default**, the value the resolving code uses when the field is absent, depending on how far that resolver reaches). The numbers in the examples are neither:

- `agent.daily_budget.max_tokens` has a runtime default of `1000000000`; the full example writes `300000`, a deliberately conservative recommendation.
- `agent.context.idle_grace_seconds` has a runtime default of `0` (one batch per invocation); the full example writes `30`.
- `telegram.bucket_bump_seconds` defaults to `0`, and `telegram.bucket_max_seconds` defaults to `bucket_window_seconds` rather than to the constant 15.
- The entry gate defaults to a threshold of `0.57` and the model `typesafe/jev-1.14` while it is off; those are not recommendations, and changing the model or the question invalidates the threshold.

Per-field values, defaults and deprecation notes are in the [field reference](fields.md) and its per-section pages.

## Checking a file

Validate offline before applying or restarting:

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

A successful run prints one JSON line with `status`, `config_hash`, `warnings` and `image_enabled`. `warnings` carries the problems that do not stop startup: an incomplete agent identity, no vision model, a stripped `image` section, deprecated fields. A failing run prints one JSON line with `status: "error"` and the message to stderr, exits with code 1, and names the offending field path.

`check-config` reads the file only: it resolves no SecretRef, contacts no provider or Telegram account and checks no permissions. Passing it does not prove the deployment works — use `doctor` for real connectivity, as described in [troubleshoot startup failures and silence](../guides/troubleshooting.md).

For machine-readable constraints download the [JSON Schema](__DOCS_BASE__/config.schema.json); it comes from the same `ConfigSchema` as this page and every per-section field page.
