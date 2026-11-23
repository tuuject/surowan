# Public Release 文档重组实施拆分

- 日期：2026-11-23。
- 状态：AI 直出的实施契约，未经用户逐条审核；判断当前行为只看源码与 `apps/docs/` 正文。
- 来源：实施 [Public Release 文档重组调研与规划](20261106%20Public%20Release%20文档重组调研与规划.md) 时，派发给各子 agent（epic A–G）的共享契约，下文英文正文原样保留，供事后 review 追溯各 epic 的分工、约定与已采纳的 §10 决策。实施结果、偏差与验证见对应 devlog。

## 0. Decisions adopted (design doc §10: the recommended options were adopted for this implementation; the maintainer confirms them in PR review)

- First-run order: install + one-time-code sign-in + working Agent model → persona in Playground → Telegram.
  Keep a short "go straight to Telegram" branch link.
- Branding: home pages and guides/index say 「塑料碗 Harness（Surowan Harness）」 once (a persona-agnostic
  Harness server); body text uses 「塑料碗」 (zh) / "Surowan" (en).
- Public interfaces (HTTP/MCP/CLI incl. pairing signature): document current behaviour of this commit;
  state once in developer/index that only documented behaviour is supported and there is no long-term
  compatibility promise yet. No OpenAPI.
- Docs follow the source commit (existing provenance notice); no separate versioning.
- "Bot" = the Telegram account the deployment connects; no multi-bot/persona-library entity. Multi-IM only in
  developer/extensions as an internal boundary, never as a user promise.
- Extensions: built-in contracts and source-level development only; no marketplace / uploaded skills / hot plugins.
- Merge granularity exactly as the tree below (recurring alarms + outbound MCP → guides/tools; entry gate +
  Reviews + Resume → guides/tuning, hand-off part → guides/agent-assisted; Keychain → guides/admin).
- Screenshots: Playwright, light theme, desktop 1440×1000, DPR 1, `zh-CN` + `en` only.
- Old URLs: redirected (see §6). Memory + dictionary merged into guides/knowledge.

## 1. Site layout (Rspress 2 native i18n)

```
apps/docs/
  i18n.json                     (theme strings, if needed)
  rspress.config.ts             lang: 'zh' (default, served at /), locales zh + en (en served at /en/)
  content/
    public/                     shared by both locales (examples/, config.schema.json, screenshots/, _redirects ...)
    zh/  _nav.json  index.md (site home)  docs/<tree below>
    en/  _nav.json  index.md (site home)  docs/<tree below>
```

Both locales have the SAME relative file tree. URLs: zh `/docs/guides/installation`, en `/en/docs/guides/installation`.
The bundled Bot manual (`src/manual/`) is packed ONLY from `content/en/docs/`.

## 2. Page inventory (the H1 MUST equal `title`; keep these titles exactly)

### docs/ root
| path | zh title | en title | owner |
| --- | --- | --- | --- |
| index.md | 使用文档 | Documentation | C |
| (site home) ../index.md | 塑料碗 | Surowan | C |

### guides/ — 指南 / Guides
| path | zh title | en title | owner |
| --- | --- | --- | --- |
| guides/index.md | 从这里开始 | Start here | C |
| guides/installation.md | 安装与首次登录 | Install and sign in | C |
| guides/first-persona.md | 你的第一个人设 | Your first persona | C |
| guides/first-bot.md | 你的第一只 Bot | Your first bot | C |
| guides/models.md | 接入和更换模型 | Connect and switch models | C |
| guides/playground.md | 用虚拟群聊试验人设和工具 | Try personas and tools in the Playground | C |
| guides/admin.md | 管理面板、密钥与访问安全 | Admin Panel, secrets and access | C |
| guides/tuning.md | 按表现和费用调优 | Tune behaviour and cost | D1 |
| guides/chats.md | 为不同群和话题设置边界 | Set boundaries per chat and topic | D1 |
| guides/agent-assisted.md | 让你的本地 Agent 帮你调整塑料碗 | Let your local agent tune Surowan | D1 |
| guides/troubleshooting.md | 排查启动失败和不回复 | Troubleshoot startup failures and silence | D1 |
| guides/knowledge.md | 管理记忆与辞典 | Manage memory and the dictionary | D2 |
| guides/images.md | 看图、Sticker 与图片生成 | Images, stickers and image generation | D2 |
| guides/tools.md | 开启搜索、定时任务与外部工具 | Search, scheduled tasks and external tools | D2 |
| guides/maintenance.md | 升级、备份与恢复 | Upgrade, back up and restore | D2 |

Sidebar order (guides/_meta.json): index, installation, first-persona, first-bot, tuning, agent-assisted, models,
playground, chats, knowledge, images, tools, admin, maintenance, troubleshooting.

### configuration/ — 配置文件参考 / Configuration reference
| path | zh title | en title | owner |
| --- | --- | --- | --- |
| configuration/index.md | 配置文件入门 | Configuration file basics | E1 |
| configuration/lifecycle.md | 配置生命周期 | Configuration lifecycle | E1 |
| configuration/secrets.md | 密钥与路径 | Secrets and paths | E1 |
| configuration/telegram.md | Telegram 配置 | Telegram settings | E1 |
| configuration/providers.md | Provider 与模型定义 | Providers and models | E1 |
| configuration/models-dev.md | 模型元数据目录 | Model metadata catalog | E1 |
| configuration/agent.md | Agent 配置 | Agent settings | E1 |
| configuration/vision.md | Vision 配置 | Vision settings | E1 |
| configuration/tool-model.md | Tool Model 配置 | Tool model settings | E1 |
| configuration/image.md | 图片生成配置 | Image generation settings | E2 |
| configuration/dictionary.md | 辞典配置 | Dictionary settings | E2 |
| configuration/web-search.md | 网络搜索配置 | Web search settings | E2 |
| configuration/web-fetch.md | 网页读取配置 | Web fetch settings | E2 |
| configuration/mcp.md | 外部 MCP 配置 | External MCP settings | E2 |
| configuration/admin.md | Admin Panel 服务配置 | Admin Panel service settings | E2 |
| configuration/developer.md | 调试记录配置 | Debug recording settings | E2 |
| configuration/storage.md | 数据路径与保留 | Data paths and retention | E2 |
| configuration/fields.md + fields-<section>.md | GENERATED (gitignored) by scripts/docs/prepare.ts | | A (infra), E1 (content) |

Sidebar order: the hand-written pages in the table order, then `fields` last. `fields-<section>.md` stay out of
the sidebar (linked from fields.md and from the matching hand-written page).

### developer/ — 开发者参考 / Developer reference
| path | zh title | en title | owner |
| --- | --- | --- | --- |
| developer/index.md | 选择接口 | Choosing an interface | F1 |
| developer/http/index.md | HTTP 公共约定 | HTTP API conventions | F1 |
| developer/http/audit.md | 审计、续跑与导出接口 | Audit, resume and export API | F1 |
| developer/http/configuration.md | 配置、闸门与工具管理接口 | Configuration, gate and tool API | F1 |
| developer/http/data.md | 知识与闹钟数据接口 | Knowledge and alarm data API | F1 |
| developer/http/playground-images.md | 虚拟群聊与图片接口 | Playground and image API | F1 |
| developer/mcp-server.md | MCP Server | MCP server | F2 |
| developer/service-cli.md | 服务端 CLI | Server CLI | F2 |
| developer/client-cli.md | 客户端 CLI（surowan-utils） | Client CLI (surowan-utils) | F2 |
| developer/replay.md | Invocation 预检与重放 | Invocation preflight and replay | F2 |
| developer/telegram-commands.md | Telegram 命令 | Telegram commands | F2 |
| developer/extensions.md | 扩展与 IM 宿主边界 | Extensions and IM host boundaries | F2 |
| generated catalogs (F1 decides names under developer/, e.g. developer/http/endpoints.md, developer/mcp-tools.md) | GENERATED (gitignored) | | F1 |

`developer/http/` is a nested sidebar directory (label zh「HTTP 接口」, en "HTTP API").
docs/_meta.json labels: zh 指南 / 配置文件参考 / 开发者参考; en Guides / Configuration reference / Developer reference.

## 3. Writing conventions (all content epics)

- Each page: frontmatter `title` + `description` (one sentence, in that locale), exactly ONE H1 equal to the title.
- Write BOTH locales for every page you own. English is written for native English readers (idiomatic, not a
  literal translation) but covers the same facts, steps, warnings and examples as the zh page; same section
  structure so readers can switch languages. zh follows the tone of the existing zh docs.
- Links: relative `.md` links. Links to pages owned by ANOTHER epic: page-level only, NO `#anchor`
  (their headings are not written yet). Anchors are fine inside pages you own. Never link to old paths.
- Public downloads: `__DOCS_BASE__/examples/<file>` / `__DOCS_BASE__/config.schema.json`, as today.
- Screenshots: do NOT write image Markdown. Put a placeholder line where the screenshot belongs:
  `<!-- screenshot: <id> | <alt text in the page's language> -->` using an id from §5. A later integration step
  turns placeholders into images. Every step must still be complete in text without the image
  (the offline English manual has no images).
- Panel UI labels: quote the exact strings from `apps/admin-next/src/locales/zh-CN/*` (zh pages) and
  `apps/admin-next/src/locales/en/*` (en pages). Nav labels (en / zh): Overview/概览, Warnings/警告,
  Tool sessions/运行记录, Reviews/批改, Contexts/上下文, Messages/消息, Playground/虚拟群聊, Memories/记忆,
  Group memory/群聊记忆, Dictionary/辞典, Alarms/提醒, Recurring alarms/循环闹钟, Image generation/图片生成,
  Image generations/生图记录, Image assets/生图素材, Image settings/图片设置, Models/模型, Providers/供应商,
  Prompts/提示词, Harness tuning/运行参数, Entry gate/入场闸门, MCP servers/MCP 服务器, Web search/网络搜索,
  Telegram/Telegram, Chats/会话, Bot admins/机器人管理员, Bot sticker sets/贴纸集, API keys/API 密钥,
  Keychain/密钥, Developer/开发者, Settings/设置, Panel preferences/面板偏好.
- Glossary (zh → en): 塑料碗 → Surowan; 人设/人格 → persona; 虚拟群聊 → Playground; 消息批次/Bucket → message
  batch (Bucket); 入场闸门 → entry gate (Decisions); 批改 → Reviews; 续跑 → Resume; 主动回复 → proactive
  replies; 活跃时段 → active hours; 注意力窗口 → attention window; 群聊记忆 → group memory; 辞典 → dictionary;
  循环闹钟 → recurring alarms; 一次性提醒(Alarm) → alarm; 一次性码 → one-time code; 配对 → pairing;
  密钥(Keychain) → Keychain; 管理面板 → Admin Panel; 运行记录/Invocation → tool session / Invocation;
  出站 MCP → outbound MCP; 反向 MCP Server → Surowan MCP server.
- JSONC snippets in docs are validated by `test/docs/examples.test.ts` with the real `loadConfig`; keep them valid
  (follow how that test marks partial snippets). Only placeholders and SecretRefs, never real secrets.
- Do not copy generated field tables into hand-written pages; link to `fields-<section>.md` instead.
- Old content: the pre-reorg zh pages live at the base commit. Read them with
  `git show 86db554f:apps/docs/content/docs/<old path>` and reuse what is still correct after checking the source.
  The old→new mapping is design doc §8.1. Fix every drift listed in design doc §2.2 and every feature in §2.3
  that belongs to your pages.
- Markdown files are exempt from the 20,000-byte commit gate; keep every page readable by the Bot in one read:
  each EN page must stay ≤ 32 KiB (`DOC_READ_MAX_BYTES` in `src/platform/doc-spaces.ts`); `test/manual-pack.test.ts`
  enforces what is packed.

## 4. Epics and waves

| wave | epic | scope |
| --- | --- | --- |
| 1 | A | bilingual skeleton & tooling (Rspress locales, all pages as stubs, prepare/manual/verify/tests/CI/redirects) |
| 1 | B1 | Playwright bilingual screenshot pipeline + first 15 scenarios |
| 2 | C | home pages, docs/index, guides: index, installation, first-persona, first-bot, models, playground, admin |
| 2 | D1 | guides: tuning, chats, agent-assisted, troubleshooting |
| 2 | D2 | guides: knowledge, images, tools, maintenance |
| 2 | E1 | config generator enrichment + configuration: index … tool-model (9 pages) |
| 2 | E2 | configuration: image … storage (8 pages) |
| 2 | F1 | interface catalog generators + developer/index + developer/http/* (6 pages) |
| 2 | F2 | developer: mcp-server, service-cli, client-cli, replay, telegram-commands, extensions |
| 2 | B2 | remaining screenshot scenarios |
| 3 | G | integration close-out: placeholders → images, screenshot pairing/orphan checks in verify, product-knowledge refresh, README/agent-doc sync, full verification |

Wave-2 epics start from the integrated wave-1 commit. Only touch files your epic owns; shared files
(`_meta.json`, `rspress.config.ts`, `scripts/manual-prepare.ts`, `src/platform/prompts/2-product-knowledge.md`)
belong to A (wave 1) and G (wave 3) unless your task says otherwise.

## 5. Screenshot scenario ids

File: `apps/docs/content/public/screenshots/<id>.<locale>.light.png`, locale ∈ {`zh-CN`, `en`}.

| id | shows | used by |
| --- | --- | --- |
| installation/sign-in-one-time-code | sign-in page with the one-time code form (empty) | installation, admin |
| models/providers-list | Providers page: a provider with fetched models | models |
| models/provider-health-check | model health check result showing the model's reply text | models |
| models/model-roles | Models page: Agent/Vision/Tool model roles + bottom save bar | models, installation |
| first-persona/prompt-editor | Prompts page: global persona saved, version visible | first-persona |
| first-persona/playground-scene | Playground room with a persona reply to a test scene | first-persona |
| first-bot/telegram-token-empty | Telegram page with the token form empty | first-bot |
| first-bot/telegram-connected | Telegram page showing connection status | first-bot |
| first-bot/chat-allowlist | Chats page with an allowed chat | first-bot, chats |
| playground/hold-pending | Playground with Hold on and pending messages | playground |
| playground/release-result | Playground after Release: output + audit entry | playground |
| admin/navigation | Overview page with the sidebar navigation | admin |
| admin/keychain | Keychain page: entries and where they are referenced | admin |
| admin/api-keys | API keys page: permission modes | admin, agent-assisted |
| admin/passkeys | Passkey management list | admin |
| tuning/bucket-timing | Telegram page: message batch timing | tuning |
| tuning/entry-gate | Entry gate global settings | tuning |
| tuning/harness-budget | Harness tuning: budgets and send protection | tuning |
| tuning/review-export | Reviews draft and the export dialog | tuning, agent-assisted |
| tuning/invocation-resume | failed tool session with Resume + auto-refresh controls | tuning, troubleshooting |
| chats/active-hours-ask-only | chat active hours and `/ask`-only setting | chats |
| chats/proactive-reply | chat proactive reply settings | chats |
| chats/entry-gate-override | per-chat entry gate override | chats |
| chats/mcp-binding | per-chat MCP binding | chats |
| knowledge/memo-editor | Memories: memo edit dialog | knowledge |
| knowledge/group-memory-progress | Group memory: consolidation progress | knowledge |
| knowledge/thirty-hour-clock | group memory 30-hour clock setting | knowledge |
| knowledge/dictionary-import | dictionary conflict / import preview | knowledge |
| images/image-settings | Image settings ready | images |
| images/generate-workbench | Image generation workbench with an inline `{{image:…}}` reference | images |
| images/generation-record | a completed image generation record | images |
| images/image-assets | Image assets with the Agent-visible toggle and AI extract | images |
| images/sticker-sets | Bot sticker sets page | images |
| tools/search-settings | Web search settings | tools |
| tools/recurring-alarm | Recurring alarm rule / cron with next-run preview | tools |
| tools/mcp-servers | MCP servers page: status, progressive exposure, skills | tools |
| troubleshooting/config-drift | file config differs from running config | troubleshooting |
| troubleshooting/mcp-degraded | MCP degraded warning | troubleshooting |
| troubleshooting/tool-calls | tool session detail: tool calls and send result | troubleshooting |

B1 owns the first 15 rows (installation … admin/passkeys); B2 owns the rest.

## 6. Old URL redirects (A implements in `apps/docs/content/public/_redirects`, zh root only)

| old (under /docs/) | new (under /docs/) |
| --- | --- |
| start/quick-start, start/installation | guides/installation |
| start/agent-assisted, configure/admin-agent-pairing, reference/cli-surowan-utils-skill | guides/agent-assisted |
| configure/config-file | configuration/ (index) |
| configure/telegram | guides/first-bot |
| configure/models | guides/models |
| configure/admin, configure/admin-keychain, configure/admin-api-keys | guides/admin |
| configure/admin-harness-tuning, configure/admin-invocation-review, guides/budgets, guides/proactive-replies, guides/entry-gate | guides/tuning |
| configure/admin-developer | configuration/developer |
| configure/admin-prompts, guides/personality | guides/first-persona |
| configure/admin-invocation-replay | developer/replay |
| configure/mcp-server | developer/mcp-server |
| guides/participation, guides/per-chat | guides/chats |
| guides/memory, guides/dictionary | guides/knowledge |
| guides/recurring-alarms, guides/extensions, guides/web-search | guides/tools |
| operations/upgrade, operations/backup-restore | guides/maintenance |
| operations/troubleshooting | guides/troubleshooting |
| reference/config | configuration/lifecycle |
| reference/fields, reference/fields-<section> | configuration/fields, configuration/fields-<section> |
| reference/cli | developer/service-cli |
| reference/cli-surowan-utils, reference/cli-surowan-utils-reference | developer/client-cli |

`guides/playground` and `guides/images` keep their path.

## 7. Verification commands (repo root of your checkout)

- `pnpm run lint` (fix with `pnpm run lint:fix` first), `pnpm run check`
- `pnpm test test/docs` and `pnpm test test/manual-pack.test.ts` (run separately)
- `pnpm run docs:build` then `pnpm run docs:verify`, once with `DOCS_BASE_PATH=/` and once with `DOCS_BASE_PATH=/surowan/`
  (bash: `DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify`)
- After building, `git status --porcelain` must list only files you intentionally changed (generated files stay ignored).
- Commit gate (`.githooks/pre-commit` → `scripts/file-token-limit.ts`): every staged non-Markdown text file ≤ 20,000 bytes.
  Check with `git add -A && node scripts/file-token-limit.ts` before your final report (then you may leave it staged).
