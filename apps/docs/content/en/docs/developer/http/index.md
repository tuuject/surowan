---
title: HTTP API conventions
description: Base path, the three ways to authenticate, the four permission modes, Origin checks, ID encoding, snapshot pagination, concurrency revisions, errors and paid calls.
---

# HTTP API conventions

Every panel action is a route below `/api` on the Admin Panel's own address. This page is the part that is the same for all of them; the four group pages in this directory document what each route takes and returns, and the generated [endpoint catalogs](endpoints-audit.md) list them exhaustively.

The reverse MCP server at `/mcp` is a separate entry point: it accepts only a Bearer API key and speaks JSON-RPC, see [MCP server](../mcp-server.md).

## Base address

The panel listens on `admin.host` and `admin.port`, and serves its `/api` routes on that same origin. `admin.public_url` is the address a browser uses when the panel sits behind a proxy; it also pins the `Origin` every write must carry. Configuration is documented in [Admin Panel service settings](../../configuration/admin.md).

- Routes: `/api/<route>`; the catalogs write the full path, including `/api`.
- No API version segment. Match versions with `GET /api/version` instead, as described in [choosing an interface](../index.md).
- Methods: `GET`, `POST`, `PUT`, `DELETE`. Anything else answers `405 method_not_allowed` before authentication.
- Request bodies are JSON objects. The `Content-Type` header is not checked; the body must parse as a JSON object.
- Every JSON response carries `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `x-frame-options: DENY`. There are no CORS headers, so a browser refuses to read a cross-origin `/api` response. The panel and its API are meant to share one origin.

## Three ways to authenticate

The server decides by what the request carries, in this order:

1. `POST /api/pairing/claim` — the one write that issues a client credential, and so the only one that needs none. Claiming a pairing code *is* how a client gets one.
2. `Authorization: Surowan-Signature …` — a paired client's signed request.
3. `Authorization: Bearer …` — an API key.
4. the `plasticwan_admin` cookie — a panel session.

An `Authorization` header never falls back to the cookie: a request that carries an invalid key is rejected even if the browser also has a valid session. That is deliberate — a key must not be able to borrow a session's wider rights.

### Panel session

`POST /api/auth/login` (username and password) or `POST /api/auth/pairing` (a one-time code printed by `pairing create --web` on the server) issues the session cookie:

```
set-cookie: plasticwan_admin=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<admin.session_ttl_hours × 3600>[; Secure]
```

`Secure` is added when the request arrived over HTTPS or the browser sent an `https://` `Origin`, so a TLS-terminating proxy keeps the cookie safe while a plain-HTTP loopback panel still works. The cookie is `HttpOnly` by design: JavaScript cannot read it, and the Server-Sent Events routes under `/api/live/*` exist precisely because `EventSource` cannot send an `Authorization` header.

A session is required for `/api/api-keys*`, `/api/keychain*` and `/api/live/*`, and for every `/api/auth/*` route except the ones the auth handler answers before the session gate: the sign-in routes, the session probe (`GET /api/auth/session`, which reports `authenticated: false`) and logout. API keys and paired clients are refused on all of them. See [the session-only boundary](#the-session-only-boundary).

### Bearer API key

```
Authorization: Bearer pwk_<32 random bytes, base64url>
```

The database stores only the SHA-256 digest, so the plaintext exists exactly once, in the create or rotate response. `GET /api/key` answers the caller's own identity:

```json
{
  "id": "3",
  "name": "coding-agent",
  "mode": "read_write",
  "permissions": { "read_all": true, "write_all": true, "execute_paid_operations": false },
  "kind": "api_key"
}
```

A key that is unknown, revoked or holds an illegal permission combination answers `401 unauthenticated`. A key that authenticated but lacks the route's grant answers `403 forbidden` with the missing grant named, and an unknown path answers `403` rather than `404` so a key cannot enumerate the panel. `last_used_at` moves on every successful authentication, including a request the permission gate refuses afterwards; a `401` does not move it.

### Paired-client signature

A client paired with `surowan-utils auth pair` proves each request with Ed25519:

```
Authorization: Surowan-Signature v=1,client=<client id>,ts=<unix seconds>,nonce=<16–64 base64url chars>,sig=<86 base64url chars>
```

The signature covers a fixed canonical string, one value per line, newline-separated:

```
SUROWAN-SIGNATURE-V1
<instance id: ins_ followed by 22 base64url characters>
<client id: decimal string>
<HTTP method, uppercase>
<target: /api/… plus the query string exactly as sent>
<timestamp: Unix seconds, decimal>
<nonce>
<body digest: base64url(sha256(raw request body bytes))>
```

The instance id is the `ins_…` value `pairing create` prints and the client stores at pairing time; the body digest of an empty body is the digest of zero bytes, not an exemption. Verification order matters when you debug a rejection:

1. Header shape and field patterns. A malformed header is a fixed `401 unauthenticated`; no part of it is echoed back.
2. The client exists and is not revoked. Unknown and revoked answer the same `401 unauthenticated`.
3. The timestamp is within **±300 seconds** of the server clock. Outside it: `401 signature_clock_skew`, with the measured skew in the message — a drifting container clock, not a key problem.
4. The body is read (at most 32 MiB) and the signature is verified against the canonical string.
5. The clock and the client are re-checked *after* the body arrived, so a request whose body trickled in for minutes cannot pass on a timestamp that has expired, and a client revoked mid-upload is not dispatched.
6. The nonce is recorded. Reusing one answers `401 signature_replayed`; it is remembered for `timestamp + 301` seconds, which covers the last fraction of the window, and survives a restart.

Nothing before step 6 changes state, so a replay attempt cannot consume a nonce that a failed signature did not already authorise.

## Permission modes

Every route declares one of four access requirements, and a key or paired client must hold each grant the requirement names:

| Mode | `read_all` | `write_all` | `execute_paid_operations` | What it can do |
| --- | --- | --- | --- | --- |
| `read` | yes | no | no | every audit read, redacted configuration and prompt views, model listing, invocation queries, media downloads, replay preflight |
| `read_write` | yes | yes | no | reads plus configuration, Chat, prompt, memo, dictionary, group-memory, warning and Playground-input writes — no billed call |
| `read_paid` | yes | no | yes | reads plus billed calls: invocation replay and resume, provider health check, image generation, dictionary merge preview, Playground release and retry |
| `all` | yes | yes | yes | everything above, including the routes that both change state and spend money |

A route whose access is `write+paid` needs `write_all` **and** `execute_paid_operations`; `read_write` alone or `read_paid` alone is refused with `403`. The generated catalogs print the requirement per route, so a refusal can be mapped onto a key mode without guessing.

The four modes are the only legal combinations the panel offers. A row edited directly in the database into an illegal combination (for example `write_all` without `read_all`) cannot authenticate at all; the panel shows it as invalid permissions and the next save repairs it.

Both credential kinds are handled by the same gate, so a paired client and an API key with the same mode can do exactly the same things — including the exclusions below.

## The session-only boundary

These routes are unreachable for any API key or paired client, whatever its mode:

- `/api/auth/*` — sign-in, passkey registration and login, account credentials, logout;
- `/api/api-keys*` — list, create, change mode, rotate, revoke;
- `/api/keychain*` — list, create, rotate, delete and purge named secrets;
- `/api/live/*` — the Server-Sent Events streams.

Two reasons, both structural rather than policy: a programmatic credential that could mint or list credentials would escalate itself, and an `EventSource` cannot attach an `Authorization` header, so the live streams have to be cookie-authenticated anyway. The [panel session catalog](endpoints-session.md) lists these routes with their bodies.

Because the reverse MCP server and the client CLI are both generated from the same table, neither offers a tool or command for these routes either.

## Origin checks on writes

Every `POST`, `PUT` and `DELETE` that arrives with an `Origin` header is checked before authentication:

- an `Origin` that does not parse answers `400 bad_origin`;
- with `admin.public_url` unset, the origin's host must equal the request's `Host` — a cross-origin admin request answers `403 bad_origin`;
- with `admin.public_url` set, the `Origin` must equal that exact origin — the message tells the operator to open the configured address.

A request without an `Origin` header (curl, a server-side script) is not affected: the check defends the browser, not the API. The passkey and password routes additionally require the exact public origin, because a WebAuthn ceremony bound to another origin must never be initiated.

## Identifiers and encoding

- **Numeric ids are decimal strings**, never JSON numbers: Telegram ids and SQLite `bigint` values exceed the safe-integer range, so an invocation is `"id": "8163920421"`. This covers runs, messages, Contexts, alarms, recurring alarms, room releases and the other auto-incrementing rows.
- **Other ids are opaque strings** and must be reused exactly as a response returned them: a memo is `mem_<32 hex>`, a group-memory event `gmem_<32 hex>`, a memo blob `blb_<32 hex>`, a dictionary entry `dic_<32 hex>`, an image asset or generation a UUID, and a Playground asset 32 hex characters.
- A numeric path id is validated as a signed 64-bit decimal; a malformed or out-of-range one is `400 invalid_<name>`, not `500`. An opaque id is validated against its own pattern (`400 invalid_id`).
- Path segments are percent-decoded once. A model id may contain `/`, so `PUT /api/providers/:alias/models/:id` only matches when the id is encoded (`anthropic%2Fclaude…`); undecodable segments answer `400 invalid_path`.
- `chat` filters are Telegram chat ids (a supergroup id is negative). Filters that name a model, a state or a host are validated against their own grammar and refuse control characters.

## Snapshot pagination

Listings share one page shape:

```json
{
  "items": [],
  "total": 0,
  "limit": 25,
  "offset": 0,
  "as_of": "0",
  "new_count": 0
}
```

- `limit` defaults to **25** and must be 1–100; `offset` must be a canonical non-negative decimal below 1 000 000 000. Anything else is `400 invalid_limit` / `400 invalid_offset`.
- The first request omits `as_of`. The response returns a token; send it back **unchanged** on every later page to keep reading one frozen set of rows.
- While you page, rows written after the snapshot are counted in `new_count` instead of appearing in the middle of your pages, so paging never repeats or skips a row because of an insert. Edits and deletions of snapshot rows stay live — you always see the current content of a row that was in the snapshot.
- A malformed token is `400 invalid_as_of`. Do not build one yourself: some tables use the largest row id, others an ISO timestamp.
- Filters are re-applied on every page, so changing a filter mid-pagination starts a different result set under the same token. Take a new snapshot (drop `as_of`) when you change filters.
- Some listings are not snapshot pages: Playground room timelines page with `before` + `limit`, recurring-alarm targets and image-service lists use their own `limit`/`offset` only. Their pages say so.

## Concurrency revisions

Writes to configuration and to versioned rows are optimistic: the request states the revision it read, and the write is refused if a newer one exists.

- `If-Match: <revision>`. Surrounding double quotes and a weak prefix (`W/"…"`) are stripped, so an ETag-shaped header works too.
- **config** revisions are the `revision` field of `GET /api/providers`, computed from `config.jsonc`. Every route that edits the file takes one; a missing header is `400 revision_required`, a stale one is `409 config_conflict`, and the message tells the caller to reload before editing.
- **prompt** revisions are the prompt's content hash, read from the prompt view for the scope you are editing. A stale hash is `409 prompt_conflict`.
- **entry** revisions belong to one row — a dictionary entry, a recurring alarm. The server cannot read it for you, so the caller must send the value from its own read; a stale one is `409 dictionary_conflict` / `409 revision_conflict`.

A successful write answers the new state, usually including a fresh `revision` so the next write can chain without an extra read.

## Errors

Every failure is one JSON envelope:

```json
{ "error": "config_conflict", "message": "The configuration file changed; reload before editing" }
```

`error` is a stable machine code; `message` is for a human and may change. Some failures add fields the caller needs: `running_invocations` for `model_in_use`, `aborted_invocations` after a confirmed stop, `issues` for a rejected cron rule.

| Status | Meaning |
| --- | --- |
| `400` | malformed request: body, path id, query parameter, `Origin`, or a missing/unsupported confirmation |
| `401` | no valid credential: `unauthenticated`, `signature_clock_skew`, `signature_replayed` |
| `403` | authenticated but refused: `forbidden` (missing grant, or a session-only route) |
| `404` | the named row or route does not exist (a session request; keys get `403` instead) |
| `405` | method not allowed, or a read-only group reached with a write |
| `409` | conflict: stale revision, a row still in use, an idempotency or state clash |
| `413` | `body_too_large` |
| `422` | the request parsed but cannot be applied: `config_invalid`, `secret_unresolved` |
| `429` | `health_check_busy` — three model health checks are already running |
| `500` | `internal_error`, or `config_write_failed`, `keychain_write_failed` |
| `502` | an upstream failed: `tool_model_unavailable`, `image_discovery_failed`, `merge_failed` |
| `503` | the host is not wired for this feature: `replay_unavailable`, `image_unavailable`, `mcp_unavailable`, `recurring_alarms_unavailable`, `server_stopping` |

Codes that are worth recognising because they carry a decision:

| Code | Status | What it means |
| --- | --- | --- |
| `revision_required` | 400 | send `If-Match` |
| `config_conflict`, `prompt_conflict`, `dictionary_conflict`, `revision_conflict` | 409 | someone else wrote first; reload and redo |
| `model_in_use` | 409 | runs still use the model being replaced; resend with `abort_running: true` to stop them |
| `mcp_server_in_use` | 409 | a Chat still binds the outbound server; unbind it first |
| `chat_delete_pending`, `chat_still_authorized` | 409 | the Chat is out of the file but work or an alias still holds it; retry the delete |
| `pairing_code_invalid`, `pairing_code_expired`, `pairing_code_used` | 400/400/409 | the one-time code is gone; create a new one |
| `pairing_proof_invalid`, `pairing_public_key_mismatch` | 401 | the claim was signed by another key; the ticket is *not* consumed |
| `keychain_exists`, `keychain_in_use`, `keychain_missing` | 409/409/404 | the named secret exists, is still referenced, or is gone |
| `config_invalid`, `secret_unresolved` | 422 | the file parsed but a secret did not resolve; the write was refused |
| `restart_unsupported` | 409 | no supervisor declares `PLASTICWAN_SUPERVISED=1`; restart by hand |

## Saved but not applied

A configuration write has two halves: the file changes, then the running process adopts what it can. The response separates them:

```json
{
  "revision": "…",
  "apply": { "applied": ["telegram.bucket_window_seconds"], "restart_required": [], "outside_serve": [] }
}
```

- `applied` lists the field paths this write hot-applied.
- `restart_required` lists fields that only a restart activates, and is often already non-empty because of earlier edits.
- `outside_serve` is non-empty in a standalone panel, where nothing is running to apply to.
- When the file was written but the apply failed, the status is `409` or `422` (or `500` for `publish_incomplete`) and the message starts with `config.jsonc was updated but not applied:`. The change is on disk; reload and re-apply rather than resending the old body.

`POST /api/config/apply` re-reads the file and applies what is hot-updatable. `GET /api/config/status` reports the active generation, both hashes, `restart_required` and the last apply error. `POST /api/restart` exists only when the deployment declares a supervisor.

## Paid calls and retries

Billed routes (invocation replay and resume, model health check, dictionary merge preview, MCP description draft, image generation/retry/asset extract, Playground release and retry) are marked `paid` or `write+paid` in the catalogs. There is no confirmation field on the HTTP route: the operator's approval is a property of the caller, and the CLI `--yes` flag and the MCP `confirm` argument only encode that approval client-side.

Retry behaviour is per route, because "retry" means different things:

- **Invocation replay / resume** create a *new* invocation and cost again. A client timeout after the request was accepted leaves an unknown outcome: list invocations and look for a newer row before sending another. A resume is refused with `409 resume_*` while the previous attempt is not the latest, the conversation is busy, the host is unavailable, or the bot is sleeping.
- **Playground** inputs and releases carry a `request_key`; resending the same key returns the original result (`replayed: true`, `200` instead of `201`). A retry needs an `attempt_key` and is refused when the settled attempt already had side effects.
- **Image generation** create and retry accept `idempotency_key`. Omit it and the server derives a per-second key from your username, so two identical requests in the same second collide — send your own key when a retry must be safe.
- **Dictionary merge** is two-step: `merge/preview` bills and returns a draft, `merge` writes it. Only the second step changes data, so a preview is safe to repeat.
- **Model health check** bills one prompt per call. It is refused while another check is running (`429 health_check_busy`) and while the provider connection or model definition is not applied yet (`409`).

## Two curl examples

A read with an API key:

```bash
curl -sS http://127.0.0.1:8787/api/invocations?limit=2 \
  -H "Authorization: Bearer $SUROWAN_API_KEY"
```

```json
{
  "items": [
    {
      "id": "912",
      "state": "completed",
      "created_at": "2026-11-20T08:41:02.113Z",
      "completion_reason": "idle",
      "sends_used": 1,
      "tool_call_count": 2,
      "total_tokens": 8421,
      "chat": { "host_kind": "telegram", "telegram_chat_id": "-1001234567890", "chat_type": "supergroup" }
    }
  ],
  "total": 1,
  "limit": 2,
  "offset": 0,
  "as_of": "912",
  "new_count": 0
}
```

A refused write, with the revision the caller read:

```bash
curl -sS -X PUT http://127.0.0.1:8787/api/telegram/bucket-timing \
  -H "Authorization: Bearer $SUROWAN_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: 0d6f2d…' \
  -d '{"bucket_window_seconds": 20}'
```

```json
{ "error": "config_conflict", "message": "The configuration file changed; reload before editing" }
```

Read `GET /api/providers`, take its `revision`, and send the request again — do not retry with the stale value.
