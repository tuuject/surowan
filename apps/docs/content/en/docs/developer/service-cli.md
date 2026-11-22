---
title: Server CLI
description: Options, stop-the-service boundaries and Docker forms for serve, check-config, doctor, backup, configure, admin-account, pairing and clients.
---

# Server CLI

The server entry point is `node src/cli.ts` in the repository (bin name `surowan`). Every command takes an explicit `--config <path>`. On success it writes one JSON line to stdout; on failure it writes `{"status":"error","error":"…"}` to stderr and exits with code `1`. There is no `--json` switch — the output is already the JSON a script consumes.

Error text goes through `SecretStore.redact`, but do not treat a full log as safe to publish.

## At a glance

| Command | What it does | With a running `serve` |
| --- | --- | --- |
| `serve` | Starts the bot and the Admin Panel | — |
| `check-config` | Validates JSONC, semantics and references only | safe to run |
| `doctor` | Probes real dependencies and external connections | safe, but spends models and network |
| `backup` | Retention purge, SQLite copy, image snapshot, rotation | safe to run |
| `configure` | Rewrites the config file interactively | safe, but edits the file on disk |
| `admin-account` | Creates or resets the administrator offline | **the service must be stopped** |
| `pairing …` | One-time pairing codes | **must run alongside `serve`** |
| `clients …` | Lists and revokes paired clients | **must run alongside `serve`** |

`pairing` and `clients` take no `ServeLock` and run no migrations, which is what lets an operator use them over SSH while the bot keeps running. They do require a database this version has already migrated (migration `059`), otherwise they tell you to start `serve` once. `admin-account` is the opposite case: it must hold the data-directory lock, refuses to run while `serve` holds it, and never takes the lock away.

## serve

```bash
node src/cli.ts serve --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc --takeover
```

A successful start logs `admin_started` (when the panel is enabled, with the address and port it actually bound) and then `serve_started`, which carries `mode` (the Telegram connection state; `disabled` without a token), `bot_id` and `config_hash`.

- `--takeover` replaces a local instance that currently holds the same data-directory lock: it asks the old process to shut down gracefully, then takes the lock. It is not a substitute for a production supervisor.
- The process refuses to start when `admin.enabled` is false **and** no Telegram token is configured; leaving `admin.enabled` out means `true`.
- With a Telegram token the bot connects too; without one the process still serves the panel and Playground.

## check-config

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

Prints `{"status":"ok","config_hash":…,"warnings":[…],"image_enabled":…}`. It only reads the file: no SecretRef resolution, no database, no network. So it proves the file is acceptable — not that credentials, providers, Telegram or MCP work. `warnings` includes deprecated fields and degraded features (see [Configuration lifecycle](../configuration/lifecycle.md)).

## doctor

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
node src/cli.ts doctor --config /path/to/config.jsonc --output-agent-prompt
```

`doctor` connects to the dependencies instead of inspecting them statically. It:

- Resolves every SecretRef (which also performs the one-time `key.json` → Keychain migration) and enforces the file permissions: on non-Windows systems the config must be `0600` and its parent `0700`, and `data_dir` must not grant anything to group or other.
- Creates the data directories, then checks free space (it fails below 100 MiB), SQLite's FTS5 trigram, Sharp's image codecs, `ffmpeg`/`ffprobe`, and the Lottie render chain.
- Checks that the bundled user manual was packed (a missing pack means `pnpm run manual:prepare` never ran).
- Sends one minimal request to every provider, then to every configured agent model a request that **must produce a strict tool call**; with a Vision model it also sends a 1×1 image. These requests cost real tokens and money, and they are recorded in `model_calls` with `role = 'doctor'`.
- Calls `getMe` when a Telegram token is configured. Without a token it skips the Telegram probe, and a successful run reports `telegram_status: "disabled"` and `telegram_bot_id: null`. An unreadable token reference is a configuration error that fails the run; it is never silently treated as "no Telegram".
- When the Decisions entry gate is enabled globally or on any chat, resolves its `api_key` and sends one minimal request; a failure fails the run. That probe exists for a practical reason: a dangling key reference admits every batch at runtime and goes quiet, which looks exactly like a gate that keeps rejecting.
- Starts every configured MCP server and waits for the attempts. **An unreachable server is only a warning** (`mcp_unavailable` lists `alias:error_code`), never a failed run, because at runtime it only degrades.

A successful run looks roughly like this:

```json
{
  "status": "ok",
  "runtime": "v24.0.0",
  "fts5_trigram": true,
  "sharp": true,
  "ffmpeg": true,
  "ffprobe": true,
  "lottie": true,
  "manual_documents": 42,
  "providers": 2,
  "vision": "openrouter/some-vision-model",
  "mcp_servers": 3,
  "mcp_unavailable": ["notes:connect_timeout"],
  "telegram_status": "connected",
  "telegram_bot_id": "123456789",
  "decision_gate": { "status": "disabled", "model": null, "base_url": null },
  "config_hash": "…"
}
```

`--output-agent-prompt` adds the rendered agent system prompt (template values substituted) under `agent_prompt`, which is for checking the persona and its variables — not for feeding to a model.

## backup

```bash
node src/cli.ts backup --config /path/to/config.jsonc
```

Prints `{"status":"ok","backup":"<path>"}`. The order is: purge data past `retention`, sweep expired image assets and memo blobs, take a consistent `VACUUM INTO` snapshot, copy `<data_dir>/images` to `<backup-name>.images/` beside it, then rotate old backups down to `retention.backup_copies`.

The image snapshot is best-effort: a missing directory is skipped and a copy failure is logged without invalidating the SQLite backup. The two stores are not atomic with each other, so still verify a restore in isolation (see [Upgrade, back up and restore](../guides/maintenance.md)).

## configure

```bash
node src/cli.ts configure --config /path/to/config.jsonc
```

Rewrites an **existing, loadable** configuration interactively: the provider wizard and the agent thinking level. It requires stdin to be a TTY and exits with an error otherwise. It is not an unattended initialiser and is a poor fit for a deployment agent to call. Saving writes the document under the original file's hash as its revision and reloads it immediately, so a failure never leaves a half-written configuration.

## admin-account

```bash
node src/cli.ts admin-account --config /path/to/config.jsonc --username admin
printf '%s' "$NEW_PASSWORD" | node src/cli.ts admin-account --config /path/to/config.jsonc --username admin --password-stdin
node src/cli.ts admin-account --config /path/to/config.jsonc --username admin --password-stdin --revoke-passkeys
```

Offline account management: it never touches Telegram, never starts the panel and never creates a session.

- Creates the administrator when none exists; otherwise renames the sole administrator and replaces its password.
- Revokes every login session of that account on every run. Passkeys survive unless you pass `--revoke-passkeys`.
- Never touches API keys or paired clients.
- Must acquire the data-directory lock, so the service has to be stopped. It never takes the lock over.
- Reads the password only from a hidden TTY prompt or stdin, never from argv (shell history). `--password-stdin` accepts at most 800 bytes, gives up after 10 seconds, and strips exactly one trailing LF/CRLF after EOF.
- Prints `{"status":"ok","username":…,"created":…}`.

The normal first sign-in path is not this command but `pairing create --web`; `admin-account` is the offline recovery tool (see [Admin Panel, secrets and access](../guides/admin.md)).

## pairing and clients

```bash
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read_write
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read --ttl-seconds 600
node src/cli.ts pairing create --config /path/to/config.jsonc --name coding-agent --mode read --public-key <base64url>
node src/cli.ts pairing create --config /path/to/config.jsonc --web
node src/cli.ts pairing list --config /path/to/config.jsonc
node src/cli.ts pairing cancel 12 --config /path/to/config.jsonc
node src/cli.ts clients list --config /path/to/config.jsonc
node src/cli.ts clients revoke 7 --config /path/to/config.jsonc
```

`pairing create` (client form):

- `--name` is required, 1–80 characters.
- `--mode` is required and takes `read`, `read_write`, `read_paid` or `all`; leaving it out can never silently grant the widest set.
- `--ttl-seconds` takes 60–3600, default 300.
- `--public-key` optionally pre-binds the code to the only key that may claim it (32 bytes base64url, 43 characters, unpadded). Another key gets `pairing_public_key_mismatch` and does **not** burn the code.

`pairing create --web` mints a panel sign-in code. It rejects `--mode` and `--public-key` (a panel session is the whole panel), `--name` is optional (default `Admin Panel sign-in`), and on an instance without an administrator it creates a passwordless `admin` on the way.

Both forms print the same structure: `status`, `code` (the one-time `pwp_` plaintext, shown here and never again), `instance_id`, `pairing` (`purpose`, `name`, `mode`, `permissions`, the pre-bound key fingerprint, creation and expiry times), `admin` (`host`, `port`, `public_url`), and a ready-to-run `next`. The `--web` form adds `account` (`id`, `username`, `created`).

`pairing list` shows only codes that are still pending, unused and unexpired, and never echoes the plaintext. `pairing cancel <id>` and `clients revoke <id>` take decimal `pairing` / `client` row IDs.

`clients list` returns every identity, revoked ones included, with `last_used_at` updated on each successful signature. A revocation applies to the next request; revoking twice is an error. The signature protocol itself is in [HTTP API conventions](http/index.md); the operator walkthrough is in [Let your local agent tune Surowan](../guides/agent-assisted.md).

## Docker forms

The image's `ENTRYPOINT` is `/usr/local/bin/docker-entrypoint.sh`, which hands its arguments to `node /app/src/cli.ts` and drops to the `surowan` user; the default `CMD` is `serve --config /config/config.jsonc`.

For one-shot commands use `run --rm`, which replaces `CMD`, so the subcommand goes straight after the service name:

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

Never `docker compose run` a second `serve`: it bypasses the lock and becomes a second instance.

`pairing` and `clients` must run against the **live** container, with `exec`:

```bash
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
docker compose exec -u surowan plasticwan node /app/src/cli.ts clients list --config /config/config.jsonc
```

`exec` skips the `ENTRYPOINT` and therefore runs as root by default. Root opening SQLite leaves root-owned temporary files behind and the bot then cannot write to the database, so `-u surowan` and the explicit `node /app/src/cli.ts` are both mandatory.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (an unreachable MCP server still counts as success in `doctor`) |
| `1` | Any failure: bad configuration, wrong permissions, a failed probe, a failed backup, invalid arguments |

There is no finer-grained exit code, so a script that needs details must read the `error` string on stderr. The CLI never retries automatically.
