---
title: Deploy with an AI agent
description: Hand a fresh VPS with a root password to your local coding agent over SSH to set up Docker, an HTTPS reverse proxy and the first one-time sign-in code.
---

# Deploy with an AI agent

If you just rented a fresh Linux VPS and have an IP address, a `root` account and an initial password, you do not have to run every Docker and reverse-proxy command by hand. You can hand the deployment to a local coding agent (Claude Code, Codex, OpenCode, Cursor, or similar), let it set everything up over SSH, and stop as soon as it hands you the **one-time web sign-in code**.

**You need**: a fresh Linux VPS (Debian or Ubuntu recommended, with `root` access), a local coding agent that can run terminal commands, and optionally a domain pointed at the VPS IP for HTTPS and passkeys. Do **not** hand your model API keys or Telegram bot token to the agent upfront — you will enter those yourself after signing in.

**Done when**: the container is running, logs show `admin_started`, the panel opens over HTTPS (or a local SSH tunnel), and you have a one-time `pwp_` sign-in code.

## 1. One-shot deployment prompt

Paste the prompt below to your local coding agent and replace the placeholders (remove the domain line if you do not have one yet):

```text
Please deploy Surowan on my fresh VPS over SSH end to end:

- Server IP: <your VPS IP> (SSH port 22, user root)
- Panel domain: <panel.example.com> (if none yet, replace with "no domain yet, loopback only")
- Reverse proxy preference: Caddy (automatic HTTPS; or switch to Nginx / Apache httpd)

Follow these steps in order and report briefly after each milestone:
1. Set up SSH key authentication first (check my local ~/.ssh public key and install it into /root/.ssh/authorized_keys). Never write the root password into scripts, command history or config files.
2. Check the OS and install Docker Engine plus the Docker Compose plugin. If configuring a firewall, allow only SSH and 80/443 (when a domain is used); never expose port 8787 publicly.
3. Create /srv/surowan/config and /srv/surowan/data, then download the official docker-compose.yml and minimal config.minimal.example.jsonc (saving it as /srv/surowan/config/config.jsonc).
4. Uncomment "127.0.0.1:8787:8787" in docker-compose.yml. If I gave a domain, set admin.public_url in config/config.jsonc to that https:// origin and configure the HTTPS reverse proxy (raise the body limit to at least 35 MB, disable buffering on /api/live/, and extend the stream read timeout).
5. Start the stack (`docker compose up -d`) and verify `admin_started` appears in the logs with no startup errors.
6. Mint the first web sign-in code as the non-root container user:
   docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
7. Give me the panel URL (or the local `ssh -N -L 8787:127.0.0.1:8787` tunnel command when there is no domain), the one-time code and its expiry time, then stop.

Boundaries: do not set an administrator password for me, and do not ask for my model API keys or Telegram bot token — I will enter them in the panel myself.
```

:::tip Share the public template links with the agent
Sending the links to the [Compose template](__DOCS_BASE__/examples/docker-compose.yml), the [minimal configuration](__DOCS_BASE__/examples/config.minimal.example.jsonc) and the reverse-proxy examples in [Install and sign in](installation.md) alongside the prompt prevents guesswork on file paths and fields.
:::

## 2. Handling the initial root password safely

VPS providers often start you with `root` and a plain password, which you should not leave sitting in saved chat transcripts. Two options work well:

1. **Preferred: install your SSH key yourself first, then let the agent take over.** Run these two commands once in your own terminal (skip the first if you already have a key). You type the initial password once locally, it never enters the agent's context, and every later step runs non-interactively:

```bash
ssh-keygen -t ed25519
ssh-copy-id root@<your VPS IP>
```

2. **If you did let the agent use the initial password for the first login**: once your SSH key works, sign in yourself, change the `root` password (`passwd`), and consider setting `PasswordAuthentication no` in `/etc/ssh/sshd_config` and reloading SSH so the initial password in the transcript is immediately useless.

## 3. Three things to watch during deployment

- **Never publish port 8787 directly to the internet**: keep `"127.0.0.1:8787:8787"` in `docker-compose.yml` and put public traffic behind your HTTPS reverse proxy. Without a domain, use an SSH tunnel instead of binding `0.0.0.0:8787`.
- **Always pass `-u surowan` to `docker compose exec`**: `exec` defaults to root inside the container, and opening `/data/surowan.sqlite` as root can leave root-owned SQLite temporary files that block the service from writing later.
- **Configuration file permissions**: on non-Windows hosts the config directory must be `0700` and `config.jsonc` must be `0600`. The official image's entrypoint repairs `/config` and `/data` ownership and modes on every boot; a bare-host install must keep them set manually.

## 4. Finish the last four steps yourself

Once the agent hands you the URL and the `pwp_` one-time code, finish in your browser (about two minutes):

1. **Open the panel**: go to `https://panel.example.com/` if you set up a domain. Without one, open a local SSH tunnel first and visit `http://127.0.0.1:8787/`:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@<your VPS IP>
```

2. **Sign in with the one-time code**: choose **Sign in with one-time code** and paste `code`. Codes expire after 5 minutes by default; if yours expired, ask the agent to run `pairing create --web` again.
3. **Set durable credentials**: open **Settings → Admin credentials** and replace the password-less `admin` with your own username and password (12–200 characters). If you configured `admin.public_url` over HTTPS, register a passkey under **Settings → Passkeys** as well.
4. **Connect a model and test it**: add your provider and API key on **Providers**, pick the Agent model on **Models** and save, then click **Test** on the provider row to confirm a real reply (screenshots and details in [Install and sign in](installation.md#5-connect-an-agent-model-that-replies)).

## Next steps

- Ready to configure the bot: write [Your first persona](first-persona.md), or connect Telegram directly in [Your first bot](first-bot.md).
- Want your local agent to keep helping with audits, tuning and prompt edits: continue to [Working with coding agents](agent-assisted.md) to install the `surowan-utils` CLI and skills in one sentence and switch from `root` SSH to scoped client pairing or an API key.
- Prefer step-by-step manual setup or want the full Nginx, Caddy and Apache httpd reverse-proxy configs: see [Install and sign in](installation.md).
