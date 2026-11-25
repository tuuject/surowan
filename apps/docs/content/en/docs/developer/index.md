---
title: Choosing an interface
description: Pick between the HTTP API, the reverse MCP server and the two CLIs, understand the two programmatic credentials, and know what this section does and does not promise.
---

# Choosing an interface

Surowan exposes its administration surface once and then adapts it to four callers: the Admin Panel in a browser, the HTTP API, the reverse MCP server, and two command-line tools. This section documents the three interfaces a program can drive — and the CLI a human or an agent runs from a shell.

Everything here describes the source commit the site is built from. The footer names it; `GET /api/version` names what the server you are talking to actually runs.

## Pick the interface

| Interface | Entry point | Credential | Good for |
| --- | --- | --- | --- |
| HTTP API | `<panel origin>/api/…` | panel session cookie, `Authorization: Bearer pwk_…`, or a `Surowan-Signature` request | Scripts, dashboards, CI jobs, anything that speaks HTTP and wants the exact request and response |
| Reverse MCP server | `<panel origin>/mcp` | `Authorization: Bearer pwk_…` only | A model-driven agent that already speaks MCP and should call one tool per action |
| Client CLI (`surowan-utils`) | your workstation | the same two programmatic credentials, stored locally | A coding agent or an operator who wants read/write without hand-writing JSON |
| Server CLI (`surowan`) | the server shell | filesystem access | Installing, first sign-in, pairing, backup, diagnosis |

The HTTP API is the widest surface: every panel action is a route under `/api`, and the other programmatic interfaces are thin layers over it. The reverse MCP server generates one tool per route and the client CLI generates one command per route, both from the same table — see the [MCP tool catalog](mcp-tools.md) and the [client CLI command catalog](cli-commands.md).

Two things are deliberately not programmatic:

- **The panel itself.** Browser routes, sidebar order, query parameters and local UI state are implementation detail, not an interface.
- **Anything not in these pages.** If a route, field, error code or tool is not documented here, treat it as internal and expect it to change.

## Two programmatic credentials

Both are checked against the same route table and the same [permission modes](http/index.md), so they differ only in how the request proves who it is.

| | API key | Paired client |
| --- | --- | --- |
| Header | `Authorization: Bearer pwk_…` | `Authorization: Surowan-Signature v=1,client=…,ts=…,nonce=…,sig=…` |
| Secret on disk | the key itself, wherever you store it | an Ed25519 private key that never leaves the machine (`client-key.pem`, `0600`) |
| Replay protection | none beyond TLS — the key *is* the bearer token | per-request nonce plus a ±300-second clock window |
| Lifetime | until revoked or rotated in the panel | until the server revokes the client |
| Created by | Admin Panel → API keys | `surowan pairing create` + `surowan-utils auth pair` |

Choose an API key when a long-lived secret in a config file or secret store is acceptable — a monitoring script, a CI job, an internal tool. Choose a paired client when the caller is an agent on someone's machine that should not hold a credential the whole account shares: the pairing code is short-lived and single-use, and the private key cannot be exported from the client.

Neither credential can manage the other, nor the account: `/api/auth/*`, `/api/api-keys*` and `/api/keychain*` are reserved for a signed-in panel session.

## Version matching

`GET /api/version` answers the running build:

```json
{ "version": "v1.2.3", "channel": "Release" }
```

`channel` is `Release`, `Staging` or `Develop`. A source checkout or an unstamped build reports `Develop` and a commit-based version, so a version string is not a promise about behaviour either.

The published site and the built-in manual follow the source commit, not a release tag, and the container image you deploy may be older or newer than this page. Before relying on a route, a field or an error code:

1. Call `GET /api/version` on the server you are about to drive.
2. Compare it with the commit named in this site's footer.
3. If they differ, the running server wins. Re-read the matching page in the manual the image ships (`list_documents` / `read_document` for an agent, or the release tag on the repository).

## What is documented contract

These observables are what this section documents, and what you may build against:

- the `/api` path layout, HTTP methods, the JSON error envelope and the status codes listed on the [HTTP conventions](http/index.md) page;
- the four permission modes and which grant each route requires, including the `write+paid` combination;
- `If-Match` concurrency revisions and how a conflicting write is refused;
- `limit` / `offset` / `as_of` listing pagination;
- the paired-client signature scheme: header fields, the canonical string, the clock window and replay rejection;
- the response kind of each route (JSON, bytes, or a text/event stream);
- reverse MCP tool names and the reverse MCP protocol version;
- client CLI command names;

and, for each interface, exactly what its page documents — no more.

## What is not

Not documented here, and not a contract: database schema and migrations, module and file layout, internal prompt assembly, the SPA's routes, components and local storage keys, log line formats, and the payload shape of the `/api/live/*` event streams. An undocumented behaviour may exist, may be reasonable, and may still change without notice.

Only documented behaviour is supported. There is no long-term compatibility promise yet: a public release may rename a route, a field or an error code when the alternative is carrying a wrong abstraction forever. Where that happens, the change is described in the release notes and in this section.

There is no OpenAPI document. The route table behind the catalogs carries method, path, permission, revision, confirmation and response kind — not request bodies or response schemas — so an exported SDK or a full OpenAPI file would describe less than the hand-written pages do.

## Where to go next

- [HTTP API conventions](http/index.md) — base path, authentication, permissions, pagination, errors, paid calls.
- [Audit, resume and export API](http/audit.md) — reading runs, resuming a failed one, downloading media.
- [Configuration, gate and tool API](http/configuration.md) — everything that writes `config.jsonc`.
- [Knowledge and alarm data API](http/data.md) — memo, dictionary, group memory, alarms and recurring alarms.
- [Playground and image API](http/playground-images.md) — virtual rooms and the image workbench.
- [MCP server](mcp-server.md) — the reverse MCP endpoint, its protocol and its resources.
- [Server CLI](service-cli.md) and [Client CLI](client-cli.md) — the two command-line surfaces.
- [Invocation preflight and replay](replay.md) — re-running a recorded run without the side effects.
- [Telegram commands](telegram-commands.md) — the member-facing commands the bot itself answers.
