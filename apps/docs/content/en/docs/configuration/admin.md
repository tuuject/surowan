---
title: Admin Panel service settings
description: Listen address, port, session lifetime, static directory and public_url of the admin section, plus the enable switch, Passkey dependency and restart requirement.
---

# Admin Panel service settings

The `admin` section describes the panel's HTTP service itself: which address it binds, which port it listens on, how long a session lives, where the frontend comes from and what the panel's public address is.

The section is **required** — it may not be omitted — but only `enabled` inside it is optional.

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8787,
    "session_ttl_hours": 24,
    "public_url": "https://panel.example.com"
  }
}
```

## Fields

| Field | Meaning |
| --- | --- |
| `enabled` | Optional, `true` by default. `false` does not start the panel service at all. |
| `host` | Required. The bind address. `0.0.0.0` is what makes the port reachable through Docker's port mapping; behind a reverse proxy `127.0.0.1` is the safer choice. |
| `port` | Required, 1–65535. |
| `session_ttl_hours` | Required, 1–720. How long a signed-in session stays valid, in hours. |
| `static_dir` | Optional. The directory holding the built panel frontend; omitted, the build shipped inside the image is used. |
| `public_url` | Optional. The panel's public address. It must be a canonical origin (see below). |

### Constraints on public_url

It is not a free-form link but a **validated origin**:

- `https://`, or `http://localhost` for local testing;
- no IP literal (neither IPv4 nor IPv6); `localhost` is the exception;
- no user name, password, path, query or `#` fragment; with or without a trailing slash, both are accepted.

Once set, it fixes three things:

1. **The Passkey relying-party ID**: the origin's host name. Passkeys registered under another domain show as unusable and have to be registered again.
2. **The origin of browser writes**: a panel write must carry exactly this `Origin`, so the configuration can only be changed from that address (without `public_url`, "same host" is enough).
3. **The panel address printed by pairing**: `pairing create --web` on the server prints it in the sign-in link (without it, `http://127.0.0.1:<port>/`).

Without `public_url` there are no Passkeys: the endpoints answer `passkeys_disabled` and password sign-in is the only way in.

## How it takes effect

**The whole section needs a restart.** `admin` is not on the hot-apply list, so apply the configuration on the **Settings** page and restart the process — the panel offers **Restart now** when the deployment runs under a supervisor. The listening port, session lifetime, static directory and Passkey relying party are all fixed when the process starts.

`enabled: false` is a real "no panel" mode: the panel service does not start and the process works through Telegram alone. That is why there is a hard check — with the panel disabled *and* Telegram unconfigured (no token, or an empty one), `serve` refuses to start, because nothing would be reachable.

## First sign-in

The panel has no web sign-up endpoint. The first administrator can only come from the server:

- `pairing create --web` prints a one-time sign-in code and, when no account exists yet, creates a passwordless `admin`; set a password after signing in;
- `admin-account` creates or resets an account offline and needs the panel process to be stopped.

One-time codes come in two purposes, `client` and `web`, and each claim endpoint accepts only its own kind. Details: [Admin Panel, secrets and access](../guides/admin.md) and [Server CLI](../developer/service-cli.md).

## Example

A deployment reached only through an SSH tunnel and a reverse proxy:

```jsonc
{
  "admin": {
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 12,
    "public_url": "https://panel.example.com"
  }
}
```

`enabled` is omitted here, which means on.

## Interactions

- Panel passwords, Passkeys, API keys and the Keychain are account and credential data, not part of this section; see [Admin Panel, secrets and access](../guides/admin.md).
- The configuration file's own permissions (`0600`, parent directory `0700`) are checked by `serve` and `doctor` regardless of `admin`; see [Secrets and paths](secrets.md).
- What the panel pages do (tool sessions, Reviews, Resume, Playground): [Developer reference](../developer/index.md).

Types and ranges: [Admin field reference](fields-admin.md).
