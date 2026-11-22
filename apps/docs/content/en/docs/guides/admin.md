---
title: Admin Panel, secrets and access
description: Learn the panel's seven navigation groups, expose it safely, sign in with one-time codes and passkeys, and manage Keychain entries, API keys and display preferences.
---

# Admin Panel, secrets and access

The Admin Panel runs in the same process as `serve`. It is where you watch runs, change configuration and manage secrets. It is not this static documentation site, and it should never face the public internet directly.

## 1. Open it

The `admin` section is required; `enabled` defaults to `true`, and only an explicit `false` keeps the panel off.

```jsonc
{
  "admin": {
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 24
  }
}
```

Every `admin.*` field needs a restart. In Docker the container must bind `0.0.0.0`, but publish the port on loopback only:

```yaml
    ports:
      - "127.0.0.1:8787:8787"
```

`admin_started` in the log names the host and port actually used; if the page will not open, check that line first, then read [Troubleshoot startup failures and silence](troubleshooting.md).

## 2. The task map

The navigation has seven groups and thirty-two pages. Find yours by the job:

| Group | Pages | What it is for |
| --- | --- | --- |
| **Monitor** | Overview, Warnings | Run volume, online state and what needs attention |
| **Activity** | Tool sessions, Reviews, Contexts, Messages, Playground | Follow one run, annotate what went wrong, read raw messages |
| **Agent data** | Memories, Group memory, Dictionary, Alarms, Recurring alarms | What the bot remembers and when it acts on a schedule |
| **Media** | Image generation, Image generations, Image assets, Image settings | The generation workbench, history, reference assets and switches |
| **Agent setup** | Models, Providers, Prompts, Harness tuning, Entry gate, MCP servers, Web search | Which model it uses, what it says, what it may spend |
| **Telegram** | Telegram, Chats, Bot admins, Bot sticker sets | Connect Telegram and bound where it acts |
| **System** | API keys, Keychain, Developer, Settings, Panel preferences | Credentials, debug switches and this browser's display settings |

Day to day, **Overview**, **Tool sessions**, **Chats** and **Settings** carry most of the work; the rest is by need.

<!-- screenshot: admin/navigation | The Overview page and the seven navigation groups -->

## 3. Remote access

The panel speaks plain HTTP only; the security boundary is yours to draw:

- Local use: keep `admin.host` at `127.0.0.1` and reach it through an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 …`) or a browser on that machine.
- Remote use: put it behind a TLS reverse proxy you manage, and set `admin.public_url` to the exact origin the browser uses, for example `https://panel.example.com`.
- `public_url` must be a canonical HTTPS origin: no username, password, path, query or `#` fragment, and no IP address (`http://localhost` is allowed for local work). It is the WebAuthn relying party, so a new domain means new passkeys.

With `public_url` set, every write request must carry exactly that `Origin`, or it is refused with `bad_origin`. Without it, the request's host must match the address you opened. In practice: **use the address you opened, and do not alternate between loopback and the domain.**

## 4. Signing in: no web sign-up

There is no "create administrator" form on the web. A new instance's sign-in page looks exactly like one in use — username, password and one-time code — so nobody can tell from the page which machine is unattended.

Two ways in:

1. **A server one-time code** (`pairing create --web`): needs SSH access, does not stop the service, and creates the password-less `admin` on an empty instance.
2. **Offline account setup** (`admin-account`): needs the service stopped; for when a code is not an option or the password must be reset.

## 5. One-time code sign-in

```bash
node src/cli.ts pairing create --config /path/to/config.jsonc --web

# Docker deployment
docker compose exec -u surowan plasticwan node /app/src/cli.ts pairing create --config /config/config.jsonc --web
```

The JSON output carries `code` (starting with `pwp_`) and `pairing.expires_at` (five minutes by default; `--ttl-seconds` takes 60–3600). Open the panel, choose **Sign in with one-time code**, paste it and choose **Sign in**.

- Each code works once; expired or cancelled ones stop working. `pairing list` shows the unused ones.
- Panel codes and client pairing codes are separate: the sign-in page refuses a client code, and `surowan-utils auth pair` refuses a panel code.
- With the official image, the sign-in page shows the Docker command above with a copy button; a self-built image gets the generic hint.
- Signing in changes no password and signs no existing session out.

<!-- screenshot: installation/sign-in-one-time-code | The sign-in page with the one-time code form -->

## 6. Password, lockout and passkeys

- Usernames are 3–32 characters of letters, digits, dots, underscores or hyphens; passwords are 12–200 characters.
- Failed password attempts are counted per **TCP peer address**: ten failures from one address lock password sign-in there for 15 minutes (`too_many_attempts`). The forwarded header is deliberately ignored — a caller can forge it to get a fresh bucket. The trade-off is that behind a reverse proxy every visitor shares the proxy's address, so ten failures from anyone lock the administrator's password sign-in too. That is why a proxied deployment should set `public_url` and register a passkey.
- Passkeys need `admin.public_url` and a secure context (HTTPS, or `http://localhost`). You can register several, for example a laptop and a phone.
- While the account has no password, deleting the **last passkey** is disabled, and the page tells you to set a password under **Admin credentials** first, so you cannot lock yourself out.
- Deleting the **password** (passkey-only sign-in) requires at least one passkey registered for this site. It revokes every session and issues a new one to the current browser.
- After a domain change, old passkeys stay in the list but are marked as unusable here. Removing `public_url` only disables passkeys; it does not delete them.

<!-- screenshot: admin/passkeys | The passkey list with names, creation and last-use times -->

## 7. Recovery: reset the password offline

For a one-off sign-in, the one-time code above is faster and needs no downtime.

When the password is gone and no passkey works, use `admin-account`:

1. **Stop the service first**: the command edits the database directly and a running instance refuses it.
2. Run it interactively; the terminal hides the new password and asks twice:

```bash
docker compose run --rm plasticwan admin-account --config /config/config.jsonc --username <name>
```

3. In a non-interactive environment use `--password-stdin` and pipe the password in; never put it in the command line, where it stays in shell history and the process list.

Every run signs that account out everywhere. Passkeys survive unless you add `--revoke-passkeys`; API keys are never touched. With one administrator it renames and resets, with none it creates one, and with more than one it fails instead of guessing.

## 8. The Keychain page

No token or API key is written into the configuration: it holds `{ "jar": "name" }`, and the plaintext lives in `key.json` next to it. The **Keychain** page manages those entries:

- The list shows **Name**, **Created** and **Used by** (paths derived from the configuration file). An entry the running configuration still uses after the file changed is marked as running-only; one nothing references is **Unused**.
- **New entry** takes a name (1–64 letters, digits, `_` or `-`) and a value. You can create a secret before anything refers to it.
- **Rotate** replaces the value in place and keeps the creation time, then triggers one apply, so every connection using it — MCP servers included — picks up the new value; running sessions finish on the snapshot they started with.
- **Delete** only works for an entry nothing references. **Purge orphans** lists the names it will delete, and the server removes only those that are still orphans at confirmation time.
- When the configuration file cannot be parsed, deletes and rotations are refused rather than trusting an incomplete reference set.
- **No value is ever shown**: pages, lists and APIs only deal in names. `/api/keychain*` is an internal, panel-session-only API that neither API keys nor paired clients can reach.

<!-- screenshot: admin/keychain | The Keychain page with entries, usage and orphan cleanup -->

## 9. API keys

The **API keys** page issues keys for scripts, evaluation tools and the MCP server: pick one of four modes (read only, read + write, read + paid, all) when creating, then change the mode, rotate or revoke. The plaintext appears once, in the creation dialog. Accounts and credentials are excluded from every mode — no key can change the administrator password, manage passkeys or manage API keys themselves. For the permission details and usage, read [Let your local agent tune Surowan](agent-assisted.md) and [HTTP API conventions](../developer/http/index.md).

<!-- screenshot: admin/api-keys | The API keys page with permission modes and actions -->

## 10. Tool sessions: auto refresh and auto scroll

The **Tool sessions** list and detail follow the server's change stream: **Auto refresh** is on by default (the switch sits at the top of the list and the bottom of the detail), so a running invocation keeps showing new tool calls, model calls and send states in place. The detail also has **Auto scroll to bottom**, off by default: turn it on and every new event scrolls the page down. Both choices are stored in this browser and are independent.

## 11. Panel languages and preferences

The panel speaks English, 中文, Deutsch and العربية. The header's language menu lists each in its own name with a check on the current one; **Panel preferences** offers the same choice. Switching is immediate and needs no refresh; the choice is stored in the browser (`admin-language`). Until you pick one, the browser language decides: `zh`, `de` and `ar` prefixes map to Chinese, German and Arabic, everything else to English.

Arabic is a real right-to-left layout: navigation moves to the right and the page flips, while technical strings — model IDs, API keys, URLs, timestamps — stay left-to-right so what you copy equals what is stored.

**Panel preferences** only affect this browser: theme and language, never the configuration file, and never another browser or administrator. Errors returned by the server are always shown as the server wrote them.

## 12. A short safety checklist

- Do not expose the panel port to the internet; reach it through a TLS reverse proxy, with `admin.public_url` set.
- Keep two ways in: password plus a passkey, or at least treat a one-time code as the emergency door.
- Watch the **Keychain** page for orphans and the **Warnings** page now and then; replaced secrets do not disappear by themselves.
- Never copy a panel session cookie, an API key or `key.json` into a chat, an issue or a screenshot.
