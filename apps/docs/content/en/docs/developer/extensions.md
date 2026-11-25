---
title: Extensions and IM host boundaries
description: System Skills, the execute and mcp gateways, the built-in plugin contract, and HostKind as an internal boundary — none of it a promise of third-party platforms.
---

# Extensions and IM host boundaries

This page is about changing Surowan, not configuring it: which read-only documents the model can reach, how internal capabilities are exposed, where the built-in plugins live, and what adding an IM host would take. The first three are **source-level** extensions. There is no marketplace, no skill upload and no hot-loading of third-party plugins.

## System Skills

System Skills are read-only documentation packages shipped with the runtime, merged from two sources:

- `src/system-resources/skills/`: `image-inspection`, `memory`, `sticker-search`, `user-manual`.
- Each plugin's own `skills/` directory: `web-search`, `web-fetch`, `image-generation`, `alarms`, `dictionary`.

Both are mounted under `system:///skills/<name>/` in the virtual resource tree, with `SKILL.md` as the entry file.

- The system prompt carries only an **index**: name, one-line description and URI, one per line, declared to be the complete list. Bodies never enter the prompt.
- The model reads a body on demand with `read`, either by absolute `system:///` URI or by a relative reference plus the URI of the document it found it in (for example `uri "references/tools.md"` with `base "system:///skills/persona/SKILL.md"`).
- One read is capped at 32 KiB; a longer document ends with `[content truncated]` and reports `truncated: true`.
- Only Markdown inside the `system:///` tree is readable. Other schemes, arbitrary paths and writes are `invalid_uri` or `resource_not_found`. Documents are runtime material: they **may** explain when to use a tool, but they must not override tool constraints, the core agent protocol or the authorization rules.

Visibility is filtered in three layers, all in `createHostTooling`:

1. The host profile's `hiddenSkills`: a Playground room never sees `alarms`, `dictionary` or `sticker-search`.
2. The plugin's declared `hosts`: a skill only mounts where its plugin runs.
3. A plugin whose `available()` is false takes its capabilities **and** its skills with it (a search skill must not appear while search is off). `image-generation` additionally requires that this particular conversation enabled image generation.

Because the index is part of the system prompt hash, a change to the skill list makes affected conversations rebuild their context on the next run.

## MCP skills

An outbound MCP server that implements the `io.modelcontextprotocol/skills` extension can publish skills `read` can serve, under `mcp-skill://<alias>/<skill>/<path>`.

Those files are **external server data and untrusted**. Verification happens during discovery; an individual bad skill is dropped without costing the server its tools:

| Limit | Value |
| --- | --- |
| Skills per server | 32 |
| Files per skill | 64 |
| Bytes per file | 32 KiB |
| Skill bytes per server | 1 MiB |
| Skill file URI length | 512 |
| Index in the `read` description | At most 4096 characters, 32 entries |

Checked: the manifest shape, every URI staying inside its own root, and every file's UTF-8 byte count and `sha256` matching the manifest exactly.

Visibility is the same rule as the server's tools: the host supports MCP, the chat binds this server, the instance is ready with the server's tools resolved, and the server's own `skills` switch is on. A skill that is not visible simply does not exist for that chat; a guessed URI returns `resource_not_found`. `read` appends that index to its description only when the current invocation really has visible MCP skills, and it states the trust boundary there.

## execute: the internal capability gateway

`execute` is the only way the model reaches runtime-internal capabilities, and it has exactly three actions:

| Action | Input | Returns |
| --- | --- | --- |
| `search` | `query` (1–200 characters) | Matching capabilities as `[{ name, summary }]`, at most 8 |
| `help` | `tool` | That capability's `label`, `description` and parameter schema |
| `call` | `tool` plus an `input` object | A `{ text, refs }` envelope; a capability that returns a picture attaches it after the envelope |

- The directly exposed primitives **cannot** be called through `execute`: `read`, `send`, `send_reply`, `execute`, `zzz`, the Memo and group-memory read tools, `read_member_profile` and `mcp`. Neither can MCP tools.
- Input is validated against the capability's own schema. One `call` takes at most 32 KiB of input by default (Memo writes have a smaller cap) and returns at most 32 KiB.
- A capability declares whether it has a side effect, so the audit distinguishes a read from a change; billed capabilities are never retried automatically.
- An unregistered name returns a stable error code instead of a fuzzy match.

`createHostTooling` assembles the registry in this order:

1. `read_image` (when the host profile allows reading media).
2. `search_stickers` (when stickers are enabled and a sticker index exists right now).
3. The Memo Pad write tools (`add_memo`, `update_memo`, `delete_memo`) and `save_memo_image`.
4. `list_documents` / `read_document` for the bundled user manual (also 32 KiB per page).
5. Whatever the plugins contribute, in `BUILTIN_PLUGINS` order.

Skill and capability text exists only in English source; there is no localised variant.

## The progressive mcp gateway

Each server has an `exposure` setting:

- `direct`: its tools enter the tool registry as `<alias>__<tool>`.
- `progressive`: it stays out of the registry and its tools live behind the single `mcp` primitive. The model sees the alias, the operator-reviewed description and the tool count in that tool's description, then uses `search` (optionally narrowed by `server`, paged with `offset`), `help` and `call` to discover and invoke.

`call` goes through exactly the same `executeMcpTool` an exposed tool uses: the same allowlist, read-only policy, request and response limits, timeout, result conversion and audit, and the inner `tool_calls` row still records `<alias>__<tool>`. Discovery is not authorization — the gateway only ever holds this chat's resolved definitions.

The pages are bounded: at most 10 search results, at most 100 entries in a listing, and a page whose JSON would exceed 24 KiB ends early with `next_offset`.

## Built-in plugins

The plugin list is the compile-time constant `src/plugins/builtin.ts`, loaded identically by every composition root:

| id | Hosts | Skill | Offered through `execute` | When it exists |
| --- | --- | --- | --- | --- |
| `web-search` | telegram, playground | `web-search` | `web_search` | `web_search` is not disabled and at least one engine is enabled |
| `tavily` / `brave` / `exa` / `firecrawl` / `deepseek` / `searxng` / `youcom` | — | — | — (contributes an engine to `web-search.providers`) | with `web-search` |
| `web-fetch` | telegram, playground | `web-fetch` | `web_fetch` | always |
| `image` | telegram, playground | `image-generation` | `image_generate`, `list_image_models`, `search_image_assets` | the process wired an image bridge and this conversation enabled generation |
| `alarm` | telegram | `alarms` | `alarm`, `list_alarm`, `delete_alarm` | always |
| `dictionary` | telegram | `dictionary` | `lookup_dictionary`, `add_dictionary_entry`, `update_dictionary_entry` | always; it also injects dictionary context per batch |

### The plugin contract

`definePlugin` only types the literal; `loadPlugins` does the validation:

- `id` must match `^[a-z][a-z0-9-]{0,63}$`, must be unique, and may not take an id the runtime reserves (the recurring-alarm `RECURRING_ALARM_PLUGIN_ID` — it decides which task data may be rendered as trusted instructions).
- `hosts` is required and non-empty: a plugin declares its own host matrix instead of silently landing on every host.
- `dependencies` must appear earlier in the list (`loadPlugins` rejects any other order), and a plugin may **only** contribute to an extension point whose owning plugin it declares as a direct dependency.
- Extension point names look like `<owner>.<contract>` (one to three segments). A point may declare `identify`, and two plugins contributing the same identity is an error — which is how a name-resolved key such as a provider id stays unique.
- Capability names and context-injector names must be unique; an injector inherits its plugin's host matrix.

The `InvocationScope` a plugin receives holds this run's configuration, a reader for the currently published configuration, the invocation context, the deadline, the audit, storage, a **task scope bound to this plugin and conversation**, media-reference resolution, the image bridge, the tool-image store, the SecretStore and an out-of-band `steer`. Capabilities must use the objects in that scope rather than caching configuration.

### web_fetch and images

`web-fetch` is the one capability that turns an external picture into a tool image of the current invocation. Images in a page's Markdown stay as ordinary image links, and the model may `web_fetch` that URL: a JPEG, PNG or WebP response comes back as an attached image (one per call), with `referer` for sites that refuse images without it.

- One image is capped at 20 MiB; beyond that is `image_too_large`.
- The image is referenceable only within this conversation's authorization, with a TTL and no cross-conversation reuse.
- A process without a local asset store does not offer the path at all, and the description does not mention it.

## The multi-IM host boundary

The code is already decoupled by `HostKind` (`telegram` and `playground` today), but that is internal structure, **not** a promise of arbitrary platform support:

- `src/platform/im-host/` is the host-neutral contract layer: identity (`HostKind`, conversation references, sender references), message cues (`MessageCues`), delivery, policy and configuration source.
- `src/platform/host-profile.ts` is the host trait table: media reads, stickers, MCP, sleep, budget scope, configuration source, intake kind (`bucket` or `release`), delivery record kind, snapshot format, and each host's model-visible wording. Core code reads a trait or writes an exhaustive `switch`; it never writes `kind === 'telegram'`.
- `src/platform/config/projection.ts` is the only place core code learns where a host's configuration lives in the file: `configuredChats`, `allConfiguredChats`, `hostIntakeSettings`, `resolveChatConfig` and friends. `config.telegram` remains the file shape and the panel contract, but core never reads it directly.
- `src/ingress/intake/` is the host-neutral intake and message-batch path; `src/ingress/telegram-ingestion/` and `src/ingress/playground.ts` are each host's own edge.
- Three boundary tests hold the line: `test/im/host-literals.test.ts` (no host literal in core), `test/config/host-projection-boundary.test.ts` (no `config.telegram` read in core) and `test/im/transport-imports.test.ts` (`grammy` only inside a host boundary).

Adding a host is a **source-level** change: a new `HostKind`, a new `HostExecutionProfile`, the configuration projection, the edge intake, the adapter, and any host-specific prompt wording. There is no third-party host plugin mechanism and no stable host extension API; this project serves Telegram and the local Playground only.

## What does not exist

Written down so nobody goes looking:

- A plugin marketplace, plugin package installation, or hot-loading third-party plugins at runtime.
- Uploading skills. Model skills have exactly two sources: `system:///` and `mcp-skill://`, the latter published by a server and verified.
- Arbitrary code execution, a shell, or unrestricted filesystem access. Everything the model does stays inside the tool boundary.
- A programmable third-party IM host integration.
