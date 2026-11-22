---
title: Upgrade, back up and restore
description: Upgrade versions, migrate keys and data, understand retention cleanup, and work through the backup and offline restore checklist.
---

# Upgrade, back up and restore

Upgrading, backing up and restoring are three different jobs. An upgrade changes code, configuration formats and the database schema; a backup decides whether you can return to the state before the upgrade; a restore only counts once you have proved it in an environment isolated from production.

One rule runs through all of it: **only one `serve` process per data directory**. One-off commands such as `check-config`, `doctor` and `backup` do not start `serve` and may coexist with a running container — but never start a second `serve` with `docker compose run`.

## Upgrading

### Record the starting point

Before touching anything, note three things: the current image tag (or source commit), the configuration hash (`config_hash` from `check-config`), and where `surowan.sqlite` lives in the data directory. Database migrations, configuration format changes and image changes are separate steps, and a successful migration does not mean you can safely downgrade.

### Image tags

CI publishes to `ghcr.io/tuuject/surowan` when `main` or a `v*` tag is pushed:

| Tag | Updated when |
| --- | --- |
| `latest` | A stable `v*` tag is pushed; `<version>` (e.g. `1.2.3`) and `<major>.<minor>` (e.g. `1.2`) are published at the same time |
| `<version>` / `<major>.<minor>` | Same. Pinning a version gives a reproducible deployment |
| `main` | Every push to `main`; rolling development build |
| `0.0.0-next-<timestamp>` | Every push to `main`, pinning that build and creating a GitHub pre-release; only the newest 20 are kept |

`latest` follows stable `v*` tags only, never `main`. Released versions are the non-pre-release entries in GitHub Releases.

### Steps

1. Make a backup first (see below), and confirm that your configuration, prompts and `key.json` have their own protected backup routine — they are not in the database.
2. Pull the target image:

   ```bash
   docker compose pull
   ```

   If you build it yourself, run `docker build -t surowan:local .`, point compose at that image, and keep the remaining steps.

3. Validate the existing configuration with the target version:

   ```bash
   docker compose run --rm plasticwan check-config --config /config/config.jsonc
   ```

4. Replace the running service with `docker compose up -d`. Let the old container drain in-flight invocations; do not push `stop_grace_period` below 30 seconds.
5. Follow the log and confirm all three: the database migration finished, `startup_catch_up_completed` appeared (the catch-up pull is done), and `serve_started`. Note the new `config_hash`.
6. Send one controlled test message in an allowed Chat and check its state and send result in **Tool sessions**.

### What migrates automatically

Three things change on their own; there is no migration script to run by hand.

- **Database schema**: `serve` applies pending migrations from `schema_migrations` at startup. When the database file already exists and migrations are pending, it first writes `pre-migration-<time>-<uuid>.sqlite` into `paths.backups`, then applies them. Those copies rotate against `retention.backup_copies`, but only among themselves, so an automatic upgrade step never deletes a regular `surowan-*.sqlite` backup or its `.images` snapshot. `check-config` and `backup` do not run migrations.
- **Keychain format**: the old `key.json` was a flat `{ "name": "value" }` map; the current one is `{ "version": 1, "entries": { … } }`. `serve`, `doctor` and `configure` migrate it in place and idempotently, keeping every name and adding `created_at`. An already-migrated file is left alone. If a command says the key jar still uses the old format, run `serve` or `configure` once.
- **Configuration defaults**: defaults and inheritance evolve between versions, and the running values are whatever the current version resolves. Never infer a default from an example.

### Deprecated fields to clean up by hand

The following fields are still accepted by the schema and the file still loads, but they have **no effect at all**:

| Field | Replacement |
| --- | --- |
| `agent.memory_ttl_warning_days` | None (just delete it) |
| `agent.send_empty_text_fallback_enabled` | Set `agent.send_empty_text_strategy` to `"random_text"` to keep the old behaviour |
| `vision.background_sticker_concurrency` | None (just delete it) |
| `mcp.servers[].required` | None (just delete it; startup no longer waits for MCP) |

When one is present, the `warnings` array from `check-config`, the `config_warnings` startup event and the **Warnings** page all name the field paths and ask you to remove them. Do remove them: keeping them only leaves a permanent warning.

### Configuration shape changes

Very old configuration files may lack the `admin` section. The panel is required now, so `check-config` fails outright; add `host`, `port` and `session_ttl_hours` (`enabled` may be omitted and defaults to `true`). `telegram` went the other way and is optional now: deleting the whole section still starts the service, just without a Bot.

### Rolling back

Rolling back the image is safe: point compose's `image:` at the previous tag (or a `0.0.0-next-*` still within the newest 20) and run `docker compose up -d`.

**Database migrations do not roll back.** A migrated SQLite file must be restored from the backup you took before upgrading — which is exactly why you take one. Rehearse version-mismatch recovery in an isolated environment, never on your only copy.

## Retention cleanup

`serve` runs one cleanup at startup (before the Scheduler may launch work, so the first run after an upgrade cannot be overtaken by a large backlog) and then **every 24 hours**. Each pass reads the published configuration, so a change to `retention.online_days` is **hot-applied** and the next pass uses the new window with no restart.

The window is `retention.online_days` (the project is designed around 30 days; there is no default in the code). A pass removes:

- Finished **tool sessions (Invocations)**, their tool calls and host send rows, older than the window.
- Finished **message batches (Buckets)**, older than the window.
- Expired daily usage counters, finished group-memory consolidation batch rows, handled long tasks and recurring alarm firing records.
- Expired **short-term Memo Pad entries**, expired Context references and expired attention windows.
- Expired cached image analyses and sender rows nothing references any more.
- One-time codes that were used, cancelled or expired, and expired pairing nonces, older than the window.

It deliberately never removes:

- Chat messages, their revisions, media and **Conversation Context**: those only disappear with the Chat or an explicit truncation.
- Group-memory event summaries.
- Raw updates.
- Admin accounts, Passkeys, API keys and paired client identities: those only disappear when explicitly revoked.

Disk usage therefore grows with conversation volume, and `online_days` is not "how long chat history is kept". `backup` runs the same cleanup before it takes its snapshot.

## Backing up

`backup` does four things: run the retention cleanup, take a consistent SQLite snapshot with `VACUUM INTO`, snapshot the image directory alongside it, and rotate old backups according to `retention.backup_copies`.

```bash
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

On a host:

```bash
node src/cli.ts backup --config /path/to/config.jsonc
```

The output is `surowan-<time>-<uuid>.sqlite` under `paths.backups`, plus a matching `surowan-<time>-<uuid>.images/` directory:

- `.images/` is a full copy of `<data_dir>/images`, including original generated pictures and Memo blobs. A missing directory is skipped; a failed copy is only logged and does not invalidate the SQLite snapshot.
- The two snapshots have **no cross-store atomicity**: after a restore, a few of the newest rows may reference image files that were not copied yet.
- The image directory can be large, so make sure `paths.backups` has room.

`backup` does **not** include the following, which need their own protected copy:

- `config.jsonc`
- Prompt files (`system_prompt_file`, per-chat `instructions_file`)
- `key.json` (the Keychain)
- Secrets supplied through environment variables

The image ships no scheduler. Use a host cron job to run the command daily.

"Command succeeded" only means a backup file was written; it does not prove the restore path works.

## Restoring

There is no restore command: put the backup file back and let `serve` open it.

### Checklist

1. **Stop** whatever is using the target data directory. Two processes writing one SQLite database is not acceptable.
2. Keep a read-only copy of the original directory; never overwrite your only copy.
3. Create a **new, empty** isolated directory and copy `config/` and the prompt files into it. Then edit that configuration:
   - point `data_dir`, `paths.database`, `paths.media_cache` and `paths.backups` inside the isolated directory;
   - prompt paths resolve relative to the configuration directory, so keep them next to the new configuration;
   - secrets still come from a protected environment or `key.json`, never from a ticket or public storage.
4. Copy the candidate backup to the new `paths.database`, and the matching `.images/` directory to `images/` under the new `data_dir`.
   Do **not** copy `-wal`, `-shm` or lock files from the old directory.
5. Check integrity offline first, if the SQLite CLI is installed:

   ```bash
   sqlite3 -readonly /restore/data/restored.sqlite 'PRAGMA integrity_check;'
   ```

   It must return `ok`. On any error, keep the evidence and do not start the service.
6. Run `check-config` against that configuration and verify every path by hand:

   ```bash
   node src/cli.ts check-config --config /restore/config/config.jsonc
   ```

   Passing validation does **not** prove that the data directory is isolated or that the backup is complete.
7. Only with permission, start the isolated service and verify the audit log and one controlled message. **A Telegram token may only be polled by one instance**; a different data directory still cannot poll alongside the original bot.

For a Docker rehearsal, use a separate Compose project (a different `-p` and port) and bind the configuration and data volume to **new host directories**. Do not reuse the production `./data`, and do not assume the volume is isolated just because you copied the configuration.

### Checking isolation after a restore

- No production path may appear in the log.
- The usage and run counts on **Overview** should match the backup point, not keep growing.
- Spot-check a few entries on **Memories** and **Group memory**, and confirm their `.images/` pictures open.
- Confirm the production instance is still stopped, or has been moved to a different data directory.

## Troubleshooting

- **Configuration errors after an upgrade?** Read `check-config`'s `warnings` first: deprecated fields and missing required sections both show up there.
- **A feature still looks unavailable although the settings page says enabled?** Look for `*_warning` startup events (for example `image_service_warning`), fix the cause, then apply the configuration from **Settings**.
- **A backup much smaller than the database?** Expected: `VACUUM INTO` drops free pages and the WAL.
- **Can I roll back just the image?** Yes, but database migrations do not revert; to return to the pre-upgrade state, restore the pre-upgrade backup.

Related pages: [Data paths and retention](../configuration/storage.md), [Configuration lifecycle](../configuration/lifecycle.md), [Secrets and paths](../configuration/secrets.md), [Admin Panel, secrets and access](admin.md), [Troubleshoot startup failures and silence](troubleshooting.md).
