# Product knowledge source ledger

This ledger supports local maintenance of `src/platform/product-knowledge.ts`; it is not injected into the bot prompt. Product facts come only from the user manuals and their public examples. The index uses short English summaries plus Chinese self-ignore intent labels to preserve useful detail within the byte budget.

## Coverage

Read **21 authored manual pages in full**, all **6 navigation files**, and **3 public example sources** (24 content sources total). The generated field-reference output was absent in this checkout and was not generated or read. The manual packer defines 25 packed documents including its generated root index: 20 authored content pages, the field reference, three examples, and the root index. The website landing page is read for discovery but is replaced by the generated packed index.

All source paths in the following table are relative to `apps/docs/content/docs/`. Except for the landing page, the same paths are packed manual paths.

| Source read | Facts selected / routing role |
| --- | --- |
| `index.md` | Product identity, supported Telegram surfaces, task discovery; no link to this landing page in the baked index. |
| `start/quick-start.md` | Setup route; Surowan name with Surowan distribution/repository naming. |
| `start/installation.md` | Host/Docker deployment route; runtime requirements remain in manual. |
| `start/agent-assisted.md` | External coding-agent deployment route. |
| `configure/config-file.md` | Explicit application/no watcher, hot application versus restart, saved versus running configuration. |
| `configure/telegram.md` | Member commands, configured administrators, allowlist, Topic scope, self-ignore persistence and limitations, sending guards. |
| `configure/models.md` | Explicit model registration, input capabilities, Tool Model route. |
| `configure/admin.md` | Panel tasks, Passkey prerequisite, API-key limits, replay costs/limits, admin-reset. |
| `guides/personality.md` | Global/Chat prompts, relative paths, next-run Context rebuild, `/model` reload. |
| `guides/participation.md` | Trigger versus reply, group windows, overrides, Topic isolation, non-triggering edits/stickers. |
| `guides/per-chat.md` | Chat model overrides, Topic inheritance, `/status`. |
| `guides/memory.md` | TTL facts, Conversation isolation, manual review for lasting knowledge. |
| `guides/dictionary.md` | Scope and write boundaries, terminology versus memory, literal matching, injection/import/merge routes. |
| `guides/images.md` | Optional generation versus understanding, current-conversation references, Admin routes and application; this page is not in guides navigation but is linked and packed. |
| `guides/extensions.md` | Alarm, web_fetch limitations, MCP, read-only System Skills and bundled manual scope. |
| `guides/budgets.md` | Agent versus background Vision budgets, no automatic Context summaries, sleep and Alarm exemption. |
| `operations/upgrade.md` | Upgrade route; detailed tag and migration instructions left in manual. |
| `operations/backup-restore.md` | No restore command, separate config/Prompt/secrets backups; full isolation workflow left in manual. |
| `operations/troubleshooting.md` | Silence versus non-trigger, audit-led troubleshooting, image understanding route. |
| `reference/config.md` | Configuration semantics route; scope and lifecycle cross-check. |
| `reference/cli.md` | Service CLI versus surowan-utils command inventory, costs and interaction requirements. |

Navigation read: `_meta.json`, `start/_meta.json`, `configure/_meta.json`, `guides/_meta.json`, `operations/_meta.json`, `reference/_meta.json`.

Public example sources read and their packed routes:

| Source | Packed path |
| --- | --- |
| `apps/docs/examples/config.example.jsonc` | `examples/config.example.jsonc.md` |
| `apps/docs/examples/system-prompt.example.md` | `examples/system-prompt.example.md` |
| `docker-compose.yml` (the docs' shared Compose example) | `examples/docker-compose.yml.md` |

The examples are routed, not copied: sample quotas, model IDs, timezone and prompts do not become universal product defaults. `reference/fields.md` is a generated route listed in navigation and handled explicitly by the manual packer; no unobserved field limits were extracted from it.

Packaging-only reads: `scripts/manual-prepare.ts` established root-index replacement, unlisted-page inclusion and example wrapping; `scripts/docs-prepare.ts` established generated reference/example locations. `src/platform/doc-spaces.ts` established the logical path shape. These files and the repository's AGENTS.md supplied development/path constraints, not product behavior evidence.

## Selection and omissions

Every runtime bullet has a packed source link. Command discovery and role/scope limits take priority over numerical ranges and UI detail. The documented Bot command inventory is `/whoami`, `/ignoreme`, `/unignoreme`, `/pause`, `/resume`, `/model`, `/cut_topic`, `/allowlist`, and `/status`.

Natural-language phrases for ignore/restore are author-selected intent synonyms of the documented effects; the index explicitly distinguishes them from executable command aliases. Surowan is normalized from the repository/image naming used in setup/deployment manuals; the docs spell the display name as Surowan / 塑料碗 rather than explicitly presenting a three-name alias declaration.

Omitted from runtime text: detailed API flags/error codes, credential-storage implementation, Passkey recovery steps, release tags, environment-specific installation commands, exact budget/sleep numbers, image model metadata, dictionary matching normalization details, backup copy/isolation procedures, startup command replay rules, and full examples. The linked pages retain those details. No runtime grounding rules, hashes, source inventories, bake timestamps, or reports were added.

## Source gaps and conflicts

- **Command syntax is incomplete.** Telegram configuration names `/pause`, `/resume`, `/model`, `/cut_topic`, `/allowlist` and their `telegram.admins` access rule. It does not document full argument syntax, pause/resume scope, or cut-topic effects. Personality separately documents `/model` reload. The index lists supported names/access and that reload fact, without invented syntax or effects. `/status` is documented only as showing the effective Chat model; its privilege is not given. `/help`, `/start`, and a generic `/ignore` command are not documented and were not added from source code.
- **New Chat application conflicts within per-chat.** `guides/per-chat.md` “用 Admin Panel 编辑” step 3 says adding/deleting Chat requires restart; its “何时生效” section says new Chat hot applies immediately. Telegram, Admin, config-file, config reference and troubleshooting corroborate the latter. The index follows the dedicated lifecycle sections and consensus: add hot applies; delete/Topic changes need restart.
- **Deployment landing page is stale.** `index.md` says Docker's main path builds from a selected commit, while quick-start, installation and upgrade describe GHCR prebuilt images. The index routes to dedicated deployment pages without baking a disputed default installation command.
- **CLI Skill path prose disagrees with its examples.** `reference/cli.md` mentions `agents/skills/surowan-utils/` in prose but `.agents/skills/surowan-utils/` in copy examples. Local Skill installation paths are omitted from runtime knowledge.
- **Image guide is unlisted; configuration summary is not exhaustive.** `guides/images.md` is absent from guides navigation, while Admin links it and the packer includes unlisted Markdown. `reference/config.md`'s top-level summary omits the image section. The dedicated image guide plus public config example support optional image generation and hot application; absence from summaries is not treated as absence of the feature.
- **Generated field reference not inspected.** The checkout had neither `reference/fields.md` nor prepared `src/manual/`. Its logical path is established by navigation/packer only. No generated schema constraints were inferred or copied from implementation.
- **Plugin introduction is incomplete.** Extensions introduces web_fetch and Alarm, whereas separate image/dictionary guides document other capabilities. The index describes those capabilities from their dedicated guides and avoids claiming an exhaustive plugin registry.

## Handoff evidence

The integration owner imported the actual TypeScript constant, packed the current manual and read all 24 unique linked pages through FileSystemDocSpaces without truncation. Measured index: 6750 characters, 6828 UTF-8 bytes, 1407 tokens with tiktoken/o200k_base in a temporary environment; no project dependency was added. The generated field page is now packaged and reachable; no additional field constraints were baked from it.

The extensions manual was re-read after its product-index explanation was added; it does not change the indexed capability facts. Five one-shot model probes used the actual stable prompt, audited read/execute/document tools and synthetic sends: natural-language ignore, explicit /ignoreme, omitted configuration detail, invented command and ordinary chat. Product questions successfully read source pages; chat did not. Details and limitations are in agent-doc/product-knowledge.md. Skill frontmatter validation and 131 links across changed documentation passed.

Two scoped three-page authoring probes ran with and without the Skill. Both retained documented commands and disclosed gaps/conflicts; only the Skill runs included natural-language intent labels. Length estimates were unreliable: the first Skill probe exceeded its smaller 3000-byte limit, and a revised reminder still did not reliably keep that textual probe under budget. Accept only measured output; the actual runtime index passed its 7000-byte limit. These probes do not establish a general success rate or production-model behavior.

An independent source-comparison pass checked each of 19 runtime bullets against its cited manual pages and marked all supported. This is model-assisted evidence, not proof beyond the source excerpts; the explicit gaps and conflicts above remain relevant.
