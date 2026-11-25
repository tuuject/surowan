---
title: Playground and image API
description: Virtual rooms with identities, Hold and Release, uploads and room-scoped invocations, plus the image workbench, its assets and its generations.
---

# Playground and image API

Two features share this page because they share a caller: a script that wants to try behaviour without touching Telegram. Virtual rooms run the real agent against staged inputs; the image workbench drafts, generates and stores pictures.

The exhaustive list is in the [Playground and image catalog](endpoints-playground-images.md).

## Rooms

A room is a fake chat with its own identities. It is always "connected", so a room invocation runs without a Telegram token, and it never passes the entry gate.

| Route | Request |
| --- | --- |
| `GET /api/playground/rooms` | — |
| `POST /api/playground/rooms` | `{title, members?, request_key}` |
| `GET /api/playground/rooms/:id` | — |
| `GET /api/playground/rooms/:id/messages?before=&limit=` | — |
| `POST /api/playground/rooms/:id/messages` | `{request_key, sender_id, text?, reply_to_seq?, asset_ids?}` |
| `POST /api/playground/rooms/:id/participants` | `{name, role?, request_key}` |
| `PUT /api/playground/rooms/:id/hold` | — (empty body opens the hold) |
| `POST /api/playground/rooms/:id/releases` | `{request_key, revision, through_seq}` |
| `GET /api/playground/rooms/:id/releases/:releaseId` | — |
| `POST /api/playground/rooms/:id/releases/:releaseId/retry` | `{attempt_key}` |
| `GET /api/playground/rooms/:id/assets` | — |
| `POST /api/playground/rooms/:id/assets` | `{content_base64, mime, name?}` |
| `GET /api/playground/rooms/:id/assets/:assetId/content` | — (bytes) |
| `PUT /api/playground/rooms/:id/capabilities` | `{image_enabled, revision}` |
| `GET /api/playground/rooms/:id/invocations?limit=&offset=` | — |
| `GET /api/playground/rooms/:id/invocations/:invocationId` | — |

Every mutation carries an idempotency key (`request_key`, `attempt_key`): sending the same key twice returns the original result with `replayed: true` and `200` instead of `201`. This is how a client recovers from a timeout on a billed release without paying twice.

Room state:

- `title` and identity `name` are 1–120 printable characters; `role` is `member` or `admin`; a room is created with at most 64 members.
- `hold` is a mode switch, not a request field: `PUT` with no body opens it, and `{"hold": false}` is refused with `400 release_required` because closing a hold *is* a Release. While the hold is open, inputs queue instead of running (`admitted: false`).
- A message takes `text` (at most 16 384 characters) and optional `asset_ids` (up to four 32-hex ids uploaded to that room); `reply_to_seq` points at an earlier input.
- `capabilities` toggles the room's image switch and carries the room `revision` in the body — the room's own counter, not the config revision. A stale one is `409 room_revision_mismatch`.
- `assets` are staged uploads: `{content_base64, mime, name?}` with a body of at most 15 000 000 bytes of base64 text (a 10 MiB picture). The answer adds the real `width`, `height` and `sha256`; `GET …/content` returns the bytes.

Release is the billed operation: it seals the held inputs up to `through_seq` into one message batch and runs the agent.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/playground/rooms/7/releases \
  -H "Authorization: Bearer $SUROWAN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"request_key":"rel-1","revision":"12","through_seq":"4"}'
```

```json
{
  "release_id": "31",
  "through_seq": "4",
  "bucket_id": "1402",
  "invocation_id": "913",
  "replayed": false
}
```

It needs `write+paid`. `GET …/releases/:id` returns the release with its attempts (each an invocation) and its sends, so a client can tell "still running" from "sent nothing because the agent stayed silent". Retry accepts only a settled attempt with no side effects; otherwise `409 retry_refused`. Retrying a release whose attempt already sent something, or whose outcome is unknown, is exactly the case the panel refuses too.

Room invocations are scoped: `GET /api/playground/rooms/:id/invocations` lists only that room's runs, one `limit`/`offset` page at a time (no snapshot token), and `…/invocations/:invocationId` refuses a run that belongs to another room with `404`.

Domain refusals use their own codes — `room_not_found`, `unknown_sender`, `unknown_asset`, `unknown_input`, `unknown_release`, `unknown_release`/`unknown_input` for a bad `before`/`reply_to_seq`, `input_conflict`, `release_conflict`, `room_not_held`, `room_revision_mismatch`, `retry_refused` — and the [HTTP conventions](index.md) page maps their statuses (404 for unknown, 409 for a state clash).

## Image settings and models

`GET /api/image/status` answers `{enabled, models}`: whether the host wired image generation at all, and which configured image models it exposes. `GET /api/image/config` is the saved section:

```json
{
  "revision": "…",
  "enabled": true,
  "credentials": ["openrouter"],
  "models": [{ "id": "…", "name": "…", "provider": "openrouter", "upstreamModel": "…", "credentialRef": "openrouter", "capabilities": { "…": "…" } }],
  "credential_key_sources": { "openrouter": { "kind": "keychain", "name": "openrouter" } }
}
```

`credential_key_sources` is for a panel session only. The credential values never travel.

`PUT /api/image/config` takes the configuration revision and one of two shapes:

- `{enabled: false}` removes the whole `image` section, which leaves the Keychain entries in place for an explicit purge.
- `{enabled: true, credentials: {"<name>": <secret input>, …}, models: [...]}` writes the section. Every model's `credentialRef` must name a credential in the same body or one already saved, model ids must be unique, and a credential submitted as `null` keeps its stored reference. A plaintext secret becomes a Keychain entry; `{ "entry": "name" }` reuses one.

The answer is `{enabled, apply}` — `enabled` reflects both the file and the live bridge, so it can be `false` right after a successful save when the host has no image bridge.

`GET /api/image/models` lists the upstream catalog (`{models}`), and `GET /api/image/models/endpoints?model=<id>` lists one model's provider endpoints (`{endpoints}`). Both proxy the OpenRouter image catalog: an invalid model id is `400 invalid_model`, an upstream failure `502 image_discovery_failed`.

## Prompt assets and image assets

Both are catalog rows with a name, a description and a category; neither takes `If-Match`.

| Route | Request |
| --- | --- |
| `GET /api/image/prompts?q=&limit=&offset=` | — |
| `GET /api/image/prompts/:id` | — |
| `POST /api/image/prompts` | `{name, body, description?, category?}` |
| `PUT /api/image/prompts/:id` | any of `{name, body, description, category}` |
| `DELETE /api/image/prompts/:id` | — (archives) |
| `GET /api/image/images?q=&limit=&offset=` | — |
| `GET /api/image/images/:id` | — |
| `GET /api/image/images/:id/content` | — (bytes) |
| `POST /api/image/images` | `{name, base64, mime, description?, category?}` |
| `PUT /api/image/images/:id` | any of `{name, description, category, keywords, agentVisible}` |
| `POST /api/image/images/:id/extract` | `{}` or `{model: {provider, model, thinking_level}}` |
| `DELETE /api/image/images/:id` | — (archives) |

- A prompt `body` is 1–32 000 characters and must not contain the `{{…}}` reference delimiters — a prompt asset cannot reference another asset.
- `q` filters by text, `limit` defaults to 30 (1–100) and `offset` to 0; the listing is `{items, total, limit, offset}`.
- An image upload is `{name, base64, mime}` with `mime` one of `image/png`, `image/jpeg` or `image/webp`; the decoded picture may be at most 20 MiB.
- `PUT /api/image/images/:id` accepts `keywords` (a single line of text) and `agentVisible`. Turning `agentVisible` on is what lets the chat agent find and use the asset as a reference picture across conversations; it is an admin decision, so it is not on by default.
- `extract` is the paid half: an image-capable model looks at the asset and proposes a name and keywords. It writes nothing — the panel fills its edit dialog and you save through `PUT`. It needs `write+paid`. Its default model is the tool model; `{model: {provider, model, thinking_level}}` overrides once, validated against the live registry (`400 unknown_model`, `400 not_image_capable`, `422 unsupported_thinking_level`). When the tool model cannot read images the route answers `409 tool_model_no_image_input` with the image-capable models attached, which is exactly the list the override picker needs.
- Archiving is the delete: `DELETE` answers `{status: "archived"}` and the row keeps its bytes until the service compacts storage.

## Generations

`POST /api/image/generations` submits a real, billed generation. The body is the intent, mapped onto the image core's schema:

```json
{
  "prompt": "a cat in the rain, {{image:6f0f…}}",
  "prompt_refs": ["…"],
  "input_image_refs": ["…"],
  "model_id": "openrouter/some-image-model",
  "aspect_ratio": "3:2",
  "resolution": "2k",
  "output_count": 2,
  "extended_data": {},
  "idempotency_key": "gen-2026-11-20-1"
}
```

- `prompt` is 1–32 000 characters; inline `{{image:<asset id>}}` references are how a picture joins the prompt as reference material, in order ("image 1", "image 2", …). `prompt_refs` and `input_image_refs` are the explicit forms of the same idea and merge into one ordered, de-duplicated list (at most 16).
- `model_id`, `aspect_ratio`, `resolution` and `output_count` (1–10) are validated by the image core; the catalog's `image model list` is the place to discover valid ids and their supported ratios.
- `idempotency_key` is 1–128 characters of `[A-Za-z0-9._:-]`. Without it the server derives a per-second key from your username, so retrying is only safe when you send your own. A replay answers `{generation, replayed: true}` with `200` instead of `201`.
- `POST /api/image/generations/resolve` runs the same validation and returns the snapshot the request *would* produce, without submitting it. It is a read (`read` grant) and the cheapest way to check a prompt.
- `GET /api/image/generations/:id` returns the generation with its snapshot, attempts and outputs; `POST /api/image/generations/:id/retry` retries a settled one (billed, `idempotency_key` again). An unknown id is `404 not_found`, an archived asset `409 already_archived`.

The three write routes need `write+paid`: they change local state and spend external resources. `image/generations/resolve` needs only `read`, and the asset and prompt routes need `write`.

Image-domain error messages can be localized by the service; the `error` code is the stable part, so branch on it rather than on the text.
