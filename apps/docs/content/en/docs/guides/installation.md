---
title: Install and sign in
description: Start Surowan with Docker Compose, sign in with a one-time code from the server, and connect an Agent model that replies.
---

# Install and sign in

This page takes a fresh machine to "signed in, with a working Agent model". The persona and Telegram come in the next two pages.

**You need**: a machine that stays online, Docker with Docker Compose, and a model service's API key and endpoint. The Telegram bot can wait.

**Done when**: the log shows `admin_started`, the panel signs in and keeps a durable credential, and the Agent model is saved. Getting one reply in the Playground is a good sign, but not a prerequisite here.

## 1. Download two files

```bash
mkdir -p surowan/config surowan/data
cd surowan
```

| File | Save it as |
| --- | --- |
| [Compose template](__DOCS_BASE__/examples/docker-compose.yml) | `docker-compose.yml` |
| [Minimal configuration](__DOCS_BASE__/examples/config.minimal.example.jsonc) | `config/config.jsonc` |

The minimal configuration has no Telegram section and no providers: you add them later in the panel, which writes them back into that same file. The Compose template runs `ghcr.io/tuuject/surowan:latest`, the stable release; to follow the commit these docs were built from, build your own image and point `image` at your tag.

### Directory permissions (non-Windows)

`serve` and `doctor` require the configuration file to be `0600` and its directory `0700`. They refuse to start otherwise; they never downgrade to something looser.

```bash
chmod 700 config data
chmod 600 config/config.jsonc
```

The official image's entrypoint fixes the owner and permissions of `/config` and `/data` on every start, so inside Docker you normally do not run this by hand. A host install must. Windows has no such check.

## 2. Start it and find the panel

The template's `ports` block is commented out. The minimal configuration already binds `admin.host` to `0.0.0.0`, so publishing the panel on loopback is one uncomment:

```yaml
    ports:
      - "127.0.0.1:8787:8787"
```

```bash
docker compose up -d
docker compose logs -f plasticwan
```

Logs are one JSON object per line. `admin_started` (with `host` and `port`) means the panel is listening; `serve_started` will say `mode` is `disabled` and `bot_id` is `null`, because there is no Telegram token yet. That is expected.

## 3. Mint a one-time code on the server

There is no web sign-up page. The first sign-in uses a one-time code that only the server shell can mint:

```bash
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
```

The output is JSON. Four fields matter:

- `code`: the one-time code, starting with `pwp_`.
- `pairing.expires_at`: when it dies. Five minutes by default; `--ttl-seconds` takes 60–3600.
- `account`: on an instance with no administrator yet, the command also creates a password-less `admin`, and this field says `"created": true`.
- `next`: the panel address and what to do next — `http://127.0.0.1:8787/` unless `admin.public_url` is set.

The command runs alongside the live service; it does not stop the bot. To cancel an unused code, find it with `pairing list` and run `pairing cancel <id>`. Each code works once.

## 4. Sign in and set your credentials

1. Open `http://127.0.0.1:8787/`.
2. The sign-in page starts with the username and password form; choose **Sign in with one-time code**.
3. Paste `code` and choose **Sign in**.

On a fresh instance this signs in as `admin`, which has no password yet. A new instance deliberately looks exactly like one in use, so nobody can tell which deployment is unattended — and that is also why there is no web endpoint where a stranger could create the first account.

Then go to **Settings → Admin credentials**: pick a new username (3–32 letters, digits, dots, underscores or hyphens) and a password (12–200 characters) and choose **Update credentials**. Sessions in other browsers are signed out.

<!-- screenshot: installation/sign-in-one-time-code | The sign-in page with the one-time code form -->

## 5. Connect an Agent model that replies

1. Open **Providers** and choose **New provider**.
   - Built-in provider: enter the API key only.
   - Custom endpoint: enter the base URL (usually ending in `/v1`), the API format (choose OpenAI (Chat Completions) if unsure) and the API key.
2. Choose **Fetch models**, tick the models to enable and create them. If the listing fails, **Add manually** looks models up by ID.
3. Open **Models**, pick that model and a thinking effort in the **Agent model** card, then **Save** in the bottom bar.
4. Back on **Providers**, choose **Test** on the model row: an **OK** result with the model's own reply text means it really works.

The Agent model only needs text input; Vision is a separate, optional role and not part of this step. Metadata completion, nicknames, batch health checks and what a model switch does are all in [Connect and switch models](models.md).

## 6. Optional: a public address and passkeys

While the panel binds loopback, remote access is an SSH tunnel or a reverse proxy you manage. Passkeys need a fixed origin:

```jsonc
{
  "admin": {
    "public_url": "https://panel.example.com"
  }
}
```

`public_url` must be a canonical HTTPS origin: no path, query, credentials or fragment, and no IP address (use `http://localhost` for local work). It is the WebAuthn relying party, so a new domain means registering new passkeys.

`admin.*` fields need a restart: run `docker compose restart plasticwan`, open the panel from exactly that origin, and use **Settings → Passkeys → Add passkey**. The sign-in page then offers **Sign in with a passkey**.

## 7. Optional: offline account reset (service stopped)

If the password is gone and no passkey works, use the server's `admin-account`. It edits the database directly, so the service must be stopped (`docker compose stop plasticwan`); a running instance refuses it.

```bash
docker compose run --rm plasticwan admin-account --config /config/config.jsonc --username <name>
```

The terminal hides the new password and asks twice; a non-interactive environment can pipe it with `--password-stdin` instead of putting it in the command line. Every run signs the account out everywhere, keeps passkeys unless you add `--revoke-passkeys`, and never touches API keys. Start the service again afterwards.

## 8. Without Docker: running on the host

Useful with an existing process supervisor, or to run an unpublished commit. You need Node.js 24 or newer, FFmpeg/FFprobe and Python for media conversion, and a writable data directory.

```bash
git clone https://github.com/tuuject/surowan.git
cd surowan
pnpm install --frozen-lockfile
pnpm run admin:build
pnpm run manual:prepare
cp apps/docs/examples/config.minimal.example.jsonc config/config.jsonc
```

- `pnpm install` also builds the workspace packages; `admin:build` produces the panel's static files; `manual:prepare` packs the English manual the bot reads through `list_documents` (without it the service still starts, just without that manual).
- The minimal configuration uses container paths. On a host, switch to absolute paths and pull the panel back to loopback:

```jsonc
{
  "data_dir": "/srv/surowan/data",
  "paths": {
    "database": "/srv/surowan/data/surowan.sqlite",
    "media_cache": "/srv/surowan/data/media-cache",
    "backups": "/srv/surowan/data/backups"
  },
  "admin": {
    "host": "127.0.0.1"
  }
}
```

```bash
chmod 700 config data
chmod 600 config/config.jsonc
node src/cli.ts check-config --config config/config.jsonc
node src/cli.ts serve --config config/config.jsonc
```

`check-config` is offline: it contacts neither a model nor Telegram. Once `serve` runs, sign in with the same `pairing create --web`, using the checkout's `node src/cli.ts`. Restarts belong to systemd, a container platform or your own supervisor; the repository ships no service unit.

## What you should see

- `admin_started` in the log, and `http://127.0.0.1:8787/` opens.
- You signed in with a one-time code and left your own username and password in Settings.
- The **Models** page saved an Agent model, and **Test** on the provider returned the model's reply text.

Next: [Your first persona](first-persona.md). To connect Telegram first, go to [Your first bot](first-bot.md) — but after the model works.

If it will not start, the panel will not open, or a code is refused, see [Troubleshoot startup failures and silence](troubleshooting.md).
