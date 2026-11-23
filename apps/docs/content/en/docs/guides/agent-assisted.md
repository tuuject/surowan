---
title: Working with coding agents
description: Have your local coding agent install the surowan-utils CLI and skills in one sentence, connect through one-time pairing, an API key or MCP, and work in a read-propose-confirm-apply-verify loop.
---

# Working with coding agents

A local coding agent — Claude Code, Codex, OpenCode, or similar — is good at the tedious half of tuning: reading dozens of invocations, diffing two prompts, tracing "why did it not answer" to one audit row. The point is to let it *see* Surowan without giving it your long-lived password.

:::tip Server not deployed yet?
If you have a fresh VPS and want your agent to deploy the server itself over SSH first, start with [Deploy with an AI agent](ai-deploy.md).
:::

Start with the one-sentence setup prompt below to have your agent install the CLI and skills for you, then read on for the three credential paths, manual commands and safety boundaries.

## Set up the CLI and skills in one sentence

You do not have to look up package names or flags yourself. Paste this to your local coding agent and replace the placeholders:

```text
Please set up the Surowan CLI and agent skills on this machine:
1. Check that Node.js is >= 24, then install @tuuject/surowan-utils globally (`npm install -g @tuuject/surowan-utils`).
2. Install the CLI skill with `npx skills add tuuject/surowan --skill surowan-utils` (and add `--skill surowan-mcp` too if this agent uses MCP).
3. Run `surowan-utils auth init --json` to initialize the local client signing key.
4. Connect to my panel at <https://panel.example.com> (if you can SSH into <user@vps>, use one-time SSH pairing to mint a `read_write` pairing code on the server and claim it; otherwise walk me through creating an API key in the panel and saving it via `--api-key-stdin` without pasting the plaintext key into chat).
5. Verify with `surowan-utils doctor --json` and report the active permission mode.
```

Start a **fresh agent session** after installation so the newly added `surowan-utils` (or `surowan-mcp`) skill is loaded, then ask it to inspect invocations or propose changes.

The sections below explain each connection method and the manual commands behind it.

## Three ways in

| Entry | Good for | Credential | What it can do |
| --- | --- | --- | --- |
| SSH one-time pairing | The agent can log into your server, or you can run commands there | Its own Ed25519 private key per client; the server stores only the public key | The same four permission modes as an API key |
| API key | The agent can only reach the panel URL, and you accept handing out a long-lived key | A long-lived `pwk_` key | Four permission modes |
| MCP server | The agent speaks MCP and should use panel capability without a CLI | `Authorization: Bearer <API key>` only | Whatever that key's mode allows |

All three pass the same authorization gate. Account, password, passkey and API-key management are never available through the first two, and the MCP tool surface does not contain them either. Those actions exist only in the browser panel and in the server-side `surowan` CLI.

## Option 1: one-time pairing over SSH

This path solves one specific problem: how a coding agent that can already SSH into your VPS manages the bot without you pasting an administrator password or a long-lived API key. The answer is a short-lived one-time code plus a client-side signing identity — the code may show up in the agent's logs, while the private key never enters any context.

### 1. Create the client key locally

```bash
surowan-utils auth init --json
```

The output has `status`, `created`, `public_key`, `fingerprint` and `key_file`. Running it again is idempotent (`created: false`) and never replaces an existing key. On POSIX the key file must be `0600` and its directory `0700`; symlinks and wide permissions are rejected.

### 2. Create the pairing code on the server

```bash
# directly on the server
surowan pairing create --config /path/to/config.jsonc --name coding-agent --mode read_write

# Docker: exec into the running container, never `run --rm`
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --name coding-agent --mode read_write
```

Under Docker you must pass `-u surowan` and call `node /app/src/cli.ts` directly: `exec` bypasses the image entrypoint and runs as root by default, and root opening the database can leave root-owned SQLite temporary files that the bot then cannot write.

`--mode` is mandatory and means the same as the API-key modes below. `--ttl-seconds` sets a 60–3600 second lifetime (300 by default), and `--public-key <key>` binds the code to the only public key allowed to claim it.

The output contains the one-time `code`, the `instance_id`, the pairing details, a panel address hint and a ready-to-run `next` command. `pairing` and `clients` coexist with a running `serve` — nothing needs to stop — but they need the pairing tables of this version in the database, so a fresh data directory must have started (or restarted) `serve` once first.

### 3. Claim the code locally

```bash
surowan-utils auth pair --endpoint https://panel.example.com/ --code pwp_… --json
```

`--endpoint` is the Admin Panel base URL. Plain HTTP is allowed only for loopback; anything remote must be HTTPS. Without public HTTPS, open an SSH tunnel first and point at the local port:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@vps
surowan-utils auth pair --endpoint http://127.0.0.1:8787 --code pwp_… --json
```

Pairing stores a client credential (`endpoint`, `client_id`, `instance_id`) and leaves the private key on your machine. If a credential is already saved it fails with `already_configured`; add `--force` only when you really mean to replace it. When the code was created with `--public-key`, claiming it with another key returns `pairing_public_key_mismatch` and does not burn the code.

### 4. Verify

```bash
surowan-utils doctor --json
```

`credential` should be `client_signature`, `mode` and `permissions` are what this pairing granted, and `credential_sources` additionally reports `client_key: file`. `doctor` only makes one read-only identity call and one invocation-list probe; it never calls a model.

Two narrower commands are handy day to day: `surowan-utils auth status --json` reports the credential kind, endpoint, `mode` and `permissions` (returning `status: not_configured` plus whether a local key file still exists when nothing is saved), and `surowan-utils auth permissions --json` prints only what the current identity may do.

### Every request is signed

- Each request is bound to `instance_id`, the HTTP method, path and query, a body digest, a Unix-seconds timestamp and a one-time nonce.
- A timestamp more than ±300 seconds away from the server clock returns `signature_clock_skew`; reusing a nonce returns `signature_replayed`, including after a restart.
- The server stores only the public key. Once the signature verifies, the request passes exactly the same permission gate as a Bearer API key.
- There is no export command for the private key, and it cannot be passed as an argument or an environment variable.

### Inspect and revoke

```bash
surowan clients list --config /path/to/config.jsonc
surowan clients revoke <client-id> --config /path/to/config.jsonc
surowan pairing list --config /path/to/config.jsonc
surowan pairing cancel <pairing-id> --config /path/to/config.jsonc
```

`clients list` returns every identity, revoked ones included, and `last_used_at` moves on each successful signature; a revocation applies to the next request. `surowan-utils auth logout` on your machine **only deletes local files** — it does not revoke anything on the server, so revoke the old client there before switching machines.

## Option 2: API key

Create keys on the **API keys** page (`/api-keys`), which requires an administrator session; a key cannot manage keys. Creation asks for one of four permission modes:

| Mode | What it can do |
| --- | --- |
| Read only (`read`) | All audit reads, redacted configuration and prompt views, model list, invocation queries, media export and replay preflight. No state changes, no external cost. |
| Read + write (`read_write`) | Adds configuration, chats, prompts, memos, dictionary, group memory, alarms and Playground input writes. No billed operations. |
| Read + paid (`read_paid`) | Adds replay, provider health checks, image generation, dictionary merge preview, Playground release and retry. No configuration or state changes. |
| All (`all`) | Everything. Operations that change state *and* cost money (image generation, Playground release) need this mode. |

![The API keys page holding keys in three permission modes](__DOCS_BASE__/screenshots/admin/api-keys.en.light.png)

The plaintext is shown once, right after creation, and can never be read again; forgetting it means using *Rotate*. To hand it to an agent:

```bash
surowan-utils login --endpoint https://panel.example.com/ --api-key-stdin
```

`--api-key` leaves the key in your shell history; `--api-key-stdin` reads it to EOF without echoing, which is safer. The credential file is `~/.config/surowan-utils/credentials.json`, unencrypted, and holds one credential kind at a time (API key or paired client) — the last write wins.

## Option 3: MCP server

Surowan serves MCP on the same port as the Admin Panel, at `/mcp`, over Streamable HTTP. It ships with the server: with `admin.enabled` set to `false` nothing listens and MCP does not exist.

All the agent needs is one header, with a `pwk_...` key created on the page above:

```http
Authorization: Bearer pwk_<your API key>
```

- **Bearer API keys only.** A paired client's signature is not accepted on this entry.
- Tool names are `surowan_<panel command>` and map one-to-one onto `/api` endpoints; permissions come from the key's mode, and an insufficient mode returns an error the agent must report rather than work around.
- Calling `surowan_key_show` reads back the current key's `mode` and its three permissions, which is a good first step for every task.
- The server publishes a `surowan-mcp` skill under `skill://surowan-mcp/`, so clients supporting MCP with Skills can read it without installing anything.

The full tool surface, protocol versions and error conventions are in [MCP server](../developer/mcp-server.md).

## Install the agent skills

The repository's `skills/` directory holds the skills for external coding agents. They are unrelated to the System Skills the bot reads itself, and they are not shipped in the npm package:

```bash
npx skills add tuuject/surowan --skill surowan-utils
npx skills add tuuject/surowan --skill surowan-mcp
```

The CLI asks which agents to install into, and `-a codex` picks one directly; the common location Codex and friends read is `.agents/skills/<name>/SKILL.md`. Without the skills CLI, copy the whole directory (subdocuments and `agents/` included) so `SKILL.md` sits directly inside it, not one level deeper. Reopen the agent session afterwards and confirm it recognises the name.

How the two differ:

- **`surowan-utils`** drives the CLI. Every task starts with `surowan-utils doctor --json`, and it only continues when that exits `0` with `status: ok`; after that it loads the one subdocument the task needs — pairing and credential repair, invocation audit, replay, or panel writes.
- **`surowan-mcp`** drives MCP. It reads the key's permissions first, then uses the tools, and stops to ask you to change the mode instead of finding a way around it.

Skills do not upgrade with the CLI: a skills-CLI install updates with `npx skills update <name>`, while a manual copy is a local snapshot you have to refresh. The host still has to allow command execution and network access to your panel — installing a skill grants no permission by itself.

## The workflow that works

A reliable loop has five steps, and skipping one is how "the agent said it fixed it" happens:

1. **Read first.** Have it run `doctor`, `config show`, `prompt get global` and `invocation get <id>`, and report conclusions together with the evidence. `models list` is a view of the current configuration, not proof that an upstream provider answers.
2. **Propose.** Ask for the field, the old and new value, which chats are affected, whether it applies hot, and how to undo it. Field-level truth lives in the [configuration reference](../configuration/fields.md), not in the skill.
3. **You confirm.** Only the specific change you approved gets written. `--yes` is a mechanical gate, never the approval itself; `--dry-run` shows the exact request first.
4. **Apply.** Writes go through the same endpoints and validation as the panel, so the agent can do exactly what the panel can and nothing more.
5. **Verify.** Have it read the effective value back and cite a real invocation as evidence; "saved successfully" is not a result.

A prompt you can paste as-is:

```text
Start with `surowan-utils doctor --json` to verify the connection, then audit
invocation 12345 and explain why it did not reply. Read-only: no replay, and
do not change any configuration.
```

## Hand over a Reviews export

The Markdown exported from **Reviews** is written for exactly this hand-off: it carries full instructions, every comment, the event excerpts and a structured JSON block at the end. Given that file, an agent with the skill installed should:

1. run a read-only connectivity check (`surowan-utils doctor --json`, or `surowan_key_show` over MCP) and report the key's mode;
2. fetch the audit record and the currently effective prompts for the listed invocations;
3. return a cause, the evidence (invocation ID and event) and a change per comment, and wait for your approval before writing;
4. for the *Developer feedback* purpose, explicitly not touch the running configuration and only produce a defect report.

Messages, excerpts, model output and tool arguments are declared **untrusted data** inside the export; only your comments express intent. Replay really calls a model and really costs money: run the free preflight first, and replay only after you authorise the target, the count and any overrides.

![The purpose selector and export confirmation dialog on the Reviews page](__DOCS_BASE__/screenshots/tuning/review-export.en.light.png)

## What it should never do

- Put the panel password, a passkey, an administrator session or `key.json` into a conversation, a skill or an environment variable. If it needs a credential, it picks one of the three supported ways.
- Run the interactive `configure` to create a first configuration: that needs a TTY and only edits an existing loadable file.
- Delete the database, the media cache or `serve.lock` to make a command succeed.
- Force past a concurrent edit with `--if-match`; after a `config_conflict` or `prompt_conflict` it should re-read and re-confirm.
- Treat itself as a privilege escalator: account, password, passkey and API-key management stay with you, in the browser or on the server.

If the agent cannot connect, gets signature errors or lacks permissions, see [Troubleshoot startup failures and silence](troubleshooting.md). Every client command is documented in [Client CLI (surowan-utils)](../developer/client-cli.md), and the HTTP-side authentication rules in [HTTP API conventions](../developer/http/index.md).
