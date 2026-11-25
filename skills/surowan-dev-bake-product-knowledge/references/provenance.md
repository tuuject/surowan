# Product knowledge source ledger

This ledger supports local maintenance of `src/platform/prompts/2-product-knowledge.md`; it is not injected into the bot prompt. Product facts come only from the user manuals and their public examples. The index uses short English summaries plus Chinese self-ignore intent labels to keep useful detail compact.

## Coverage

The manuals were reorganized after the previous bake: there is now one tree per language (`apps/docs/content/{zh,en}/docs/`) and the manual packs **only `en`**. This bake therefore re-read the English tree and re-mapped every source; the previous table's pre-reorganization paths (`start/`, `configure/`, `operations/`, `reference/`) are gone, and their content now lives in `guides/`, `configuration/` and `developer/`.

| Source read | How it was read | Facts selected / routing role |
| --- | --- | --- |
| `index.md` (site landing) | in full | Task index and the three doc parts; not linked from the baked index (the pack replaces it with the generated root index). |
| `guides/index.md` | in full | Product identity (persona-agnostic Harness server), Telegram as the only real platform, the no-Telegram Admin Panel + Playground path, the first-run order. |
| `guides/installation.md` | in full | Docker or host install, one-time-code sign-in from the server, credentials step, first Agent model, `admin.public_url`/passkey note, offline `admin-account`. |
| `guides/first-persona.md` | in full | Two prompt layers, template variables, version history, Playground rehearsal, "a persona grants nothing". |
| `guides/first-bot.md` | in full | Token → Keychain entry, connection states, Telegram privacy mode, allowlist (`/allowlist` as the only outside-allowlist command), `/help`, first exchange, silence triage order. |
| `guides/models.md` | in full | Providers vs Models split, metadata lookup and models.dev fallback, nickname, three roles, model-switch stop dialog, health check, `/status` and `/effort` display. |
| `guides/playground.md` | in full | Rooms, Hold/Release, run states, retry vs Resume, room image switch, room exclusions (no gate, no participation, no MCP). |
| `guides/admin.md` | in full | Seven nav groups, remote access and `public_url`, no web sign-up, one-time codes, lockout, passkeys, `admin-account`, Keychain page, API-key modes, Tool sessions refresh, languages/RTL. |
| `guides/chats.md` | in full | Allowlist scope, Topics, per-Chat model/effort, instructions file, timezone, ignore list and self-service commands, active hours, attention window, `ask_only`, proactive replies, per-Chat gate override, MCP binding, removal vs deletion. |
| `guides/tuning.md` | in full | Evidence surfaces, entry gate (modes, bypass list, fail-open, budget), batch timing fields and cross-field rules, harness groups, proactive formula, Reviews export, Resume conditions. |
| `guides/knowledge.md` | in full | Context vs Memo Pad vs group memory vs dictionary, memo lifetimes and injection, consolidation lanes and progress, 30-hour clock, dictionary scope/matching/injection/import. |
| `guides/tools.md` | in full | Web search settings and providers, `web_fetch` limits and image fetching, alarm vs recurring alarm, recurring alarm rules/cron/targets/exemptions, MCP page, progressive exposure, MCP skills, hot application and degradation, System Skills boundary. |
| `guides/images.md` | in full | Direct vs on-demand vision, sticker sets and index, image settings, workbench and `{{image:…}}`, records, asset library (Agent-visible toggle, AI extraction), original-file sends, retention/backup/cost. |
| `guides/maintenance.md` | in full | Image tags, upgrade steps, automatic migrations, deprecated fields, retention sweep contents, backup contents (`VACUUM INTO` + `.images/`), restore checklist. |
| `guides/troubleshooting.md` | in full | `check-config` error shapes, permissions, secret failures per section, panel/pairing codes, model/image faults, gate and MCP diagnosis, group-memory failure reasons, drift. |
| `guides/agent-assisted.md` | in part (1–120 plus the API key and MCP sections) | Three ways in, pairing and signature rules, four API-key modes and their writes, MCP entry. Not read: the bundled-skill installation tail. |
| `configuration/index.md` | in full | Required vs optional sections, strict JSONC, minimal file, examples are not defaults. |
| `configuration/agent.md` | in full | Identity triple, global token budget, send guards, Context retention fields, concurrency/rate limits, deprecated `agent.*` fields. |
| `configuration/lifecycle.md` | in full | Three layers, absent vs null, defaults sources, inheritance table, explicit apply, partial apply, the behaviour matrix (hot vs restart), Keychain rotation, deprecated fields. |
| `configuration/providers.md` | in full | Built-in vs custom providers, four API kinds, model entry fields, nickname, compat, tool-schema reduction, references and hot application. |
| `configuration/telegram.md` | in part (token through sticker sets, MCP bindings, other switches, effect summary) | Optional section and three connection states, batch timing and cross-field rules, chat/Topic ranges, admins, participation, proactive replies, entry gate, group memory, sticker sets, restart fields. |
| `configuration/mcp.md` | in part (status/hot, exposure, skills, limits, deprecated `required`) | Background connect and degraded state, presentation-only fields, progressive gateway, skill limits, `required` deprecation. |
| `configuration/storage.md` | in part (retention and paths) | `online_days` is hot for the next sweep; what is kept. |
| `configuration/vision.md` | in part (model pair, `thinking_level`) | Vision enables only with both `provider` and `model`; optional section. |
| `developer/http/index.md` | in full | Three credentials, session cookie, bearer modes and grants, paired-client signature rules, the four permission modes, the session-only boundary. |
| `developer/mcp-server.md` | in part (tools, arguments, permissions, exclusions, resources and skills, results) | One tool per panel operation, confirmations, excluded account/credential routes, published skill resources, result and error shape. |
| `developer/telegram-commands.md` | in part (recognition, tiers, `/help` inventory, error replies) | Command recognition rules, the three permission tiers, the command list, deterministic replies. |
| `developer/service-cli.md` | in part (command table, exit codes) | Which subcommands exist, which may run alongside `serve`, which need the service stopped. |
| `developer/client-cli.md` | in part (dedicated commands, generic panel commands) | `surowan-utils` credential kinds and command inventory. |
| `developer/extensions.md` | in part (1–40) | System Skills sources, the `read`/`execute` boundary, the no-marketplace statement. |

Navigation read: `_nav.json`, `docs/_meta.json`, `guides/_meta.json`, `configuration/_meta.json`, `developer/_meta.json`, `developer/http/_meta.json`.

Public example sources are **routed, not copied**: `apps/docs/examples/config.example.jsonc` → `examples/config.example.jsonc.md`, `apps/docs/examples/config.minimal.example.jsonc` → `examples/config.minimal.example.jsonc.md`, `apps/docs/examples/system-prompt.example.md` → `examples/system-prompt.example.md`, `docker-compose.yml` (the docs' shared Compose template) → `examples/docker-compose.yml.md`. Sample quotas, model ids, timezones and prompts stay out of the index.

Packaging reads only: `scripts/manual-prepare.ts` (packed paths, generated pages, example wrapping, image → `(Screenshot: …)`), `scripts/docs/prepare.ts` (generated field and catalog pages). Neither is evidence for product behaviour.

## Selection and omissions

The refresh fixes the two facts the reorganization called out as stale and adds the features documented since:

- **API keys can write configuration.** The old index said keys only inspect and replay. The four modes (`read`, `read_write`, `read_paid`, `all`) each grant what they name, so `read_write`/`all` may write configuration, Chats and prompts; only account, passkey, API-key and Keychain management plus `/api/live/*` are session-only.
- **Removing a Chat is hot.** The old index put "deleted Chats" under restart. `configuration/lifecycle.md` and `guides/chats.md` both make config removal hot (runs stop, data stays); a Chat's `topic_ids` and `timezone`, `admin.*` and process paths are the restart cases. The index now also states that the panel's *delete* is the data-destroying action, with `chat_delete_pending`/`chat_still_authorized`.
- **Added**: entry gate (shadow/enforce, bypass list, fail-open, budget position, enforce stopping proactive sampling); adaptive batches (`bucket_bump_seconds`/`bucket_max_seconds` with the `idle_grace_seconds` rule); `/ask`, `/help`, `ask_only`; the full command tiers including `/effort` and `/rebuild_context`; recurring alarms; outbound MCP page, progressive `mcp` gateway, `mcp-skill://` skills, `required` deprecation; Models/Providers split with nicknames; 30-hour clock for group memory; image asset Agent visibility and AI extraction; `web_fetch` opening JPEG/PNG/WebP up to 20 MiB; Keychain rotation as a hot change; the panel/`Playground` still working without Telegram; retention sweep contents.

Command discovery and role/scope boundaries outrank numeric ranges. The documented Bot command inventory is `/whoami`, `/ignoreme`, `/unignoreme`, `/pause`, `/resume`, `/model`, `/effort`, `/cut_topic`, `/rebuild_context`, `/allowlist`, `/ask`, `/help`, `/status`; the service CLI inventory is `serve`, `check-config`, `doctor`, `backup`, `configure`, `admin-account`, `pairing`, `clients`.

Natural-language ignore/restore phrases are author-selected intent synonyms of the documented effects, not executable aliases; the index says so. Omitted from runtime text: every numeric default, field ranges, API flags and error-code tables, the panel's full page list, installation commands, model ids and prices, the Reviews draft format, backup/restore steps, MCP skill sizes and the signature string. The linked pages carry them.

## Source gaps and conflicts

- **No conflicts found between the two locales** for the facts baked here. Where the Chinese page adds a panel label, the fact still matches the English page.
- **Panel page count is documentation-level, not product behaviour.** `guides/admin.md` says "seven groups and thirty-two pages"; the index repeats the group concept only, because the page count is UI surface rather than product identity.
- **`/status` privilege.** Earlier bakes recorded "access level undocumented". `developer/telegram-commands.md` now lists `/status` in the "anyone" tier, so the index says anyone.
- **`/effort` and `/rebuild_context` argument syntax** is not spelled out for every command; the index lists names and tiers only, as before.
- **Rollout advice stays in the guide.** The entry gate's observe-then-enforce order, thresholds and model default are not baked; the index says "run `doctor` after enabling" because a broken key fails open silently.
- **Group memory and image budget wording.** The index names the exemption (alarm and recurring-alarm receipts) and the separation (background Vision, decision requests) without numbers.

## Handoff evidence

Refreshed with `pnpm run manual:prepare` output present, so every link could be checked against the packed tree: **39 links, 29 unique paths, all present** under `src/manual/`. Measured index after this bake: 9554 characters, 9630 UTF-8 bytes, GC-style estimate **2417 tokens** (4 characters per token). The previous bake measured 8916 characters / 8994 bytes / 2259 tokens; the growth is the entry gate, adaptive batches, `/ask`-only, recurring alarms, progressive MCP, asset visibility, the corrected API-key and Chat-removal facts, and the extra manual routes. The skill's 2000-token aim is **not** met — it was not met before either — so the partition stays above it until something is removed rather than reworded.

`test/manual-pack.test.ts` re-checks the baked routes against a fresh pack and the model-token budget test of the field pages. `pnpm run lint`, `pnpm run check`, `pnpm test test/docs`, `pnpm test test/manual-pack.test.ts`, `pnpm run docs:build` and `pnpm run docs:verify` were run for this change; the five model grounding probes were **not** re-run, so runtime grounding behaviour is unchanged and remains an integration-owner check. No tokenizer dependency was added; the GC estimate is not a model-token measurement.
