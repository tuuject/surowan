---
name: surowan-dev-bake-product-knowledge
description: Bake or refresh Surowan / Surowan product knowledge from the actual user manuals into the compact runtime index. Use when updating product self-knowledge, routing natural-language product questions to manual pages, or refreshing knowledge after manual changes. Runs locally in a coding-agent checkout; no bot, server, external model service, or new dependency is needed.
---

# Bake product knowledge

## Input and output

Work in the requested repository checkout. Inputs are the current user manuals under `apps/docs/content/docs/`, their `_meta.json` navigation, and the public examples and generated field reference shipped by the existing manual packer. Read [the source ledger](references/provenance.md) for the previous bake's coverage and unresolved source issues, then verify against current manuals rather than trusting that ledger as product truth.

Update `src/platform/prompts/2-product-knowledge.md`, the Markdown partition file read at startup by `src/platform/product-knowledge.ts` (`PRODUCT_KNOWLEDGE_INDEX`). Update `references/provenance.md` beside this skill with sources actually read, selection rationale, omissions, conflicts, and unresolved gaps. Keep this ledger outside the runtime partition file. Report both files, the coverage count, budget evidence, and any skipped checks.

This is a local authoring procedure. It does not install a runtime Skill, introduce a retrieval engine, require a service, or edit the bot's grounding policy. The runtime index is product facts and routes, not instructions to the answering model.

## Discover and read

1. Read the docs landing page and every `_meta.json`. Inventory all Markdown pages, including unlisted pages linked from guides. Follow links across product tasks rather than relying on sidebar titles alone; for example, image generation can exist outside navigation.
2. Read the full relevant pages, including limitations and adjacent configuration/lifecycle sections. For this small manual set, read all authored manual pages. Search the manuals for every slash command and product name, then read the surrounding sections. Search results alone are not evidence for syntax or permissions.
3. Read the public examples referenced by the manuals. The packer wraps non-Markdown downloads as Markdown. If generated resources are absent, use the repository's existing manual preparation command when authorized; otherwise record them as unavailable and avoid extracting unobserved details. Do not create a second generator.
4. Inspect `scripts/manual-prepare.ts` and `scripts/docs/prepare.ts` only to establish packaging paths and generated-resource locations. Application source, tests, README, `agent-doc`, design notes, and old changelogs are not evidence for product facts. Do not fill manual gaps from implementation knowledge.
5. Use packed document paths, relative to the `manual` space root: for example `configure/telegram.md`, `reference/fields.md`, and `examples/config.example.jsonc.md`. The site landing page is replaced by the packed `index.md`; downloadable JSON Schema and website `__DOCS_BASE__` URLs are not readable manual pages. Do not emit absolute filesystem paths or invented `manual://` URLs.

## Select facts and relationships

Choose facts that let the bot recognize its own product and find the right page before performing broad research:

- Product names and supported surfaces: 塑料碗 / Surowan, and the documented Surowan repository/distribution name.
- Every documented member/admin Bot command, preserving who may use it, scope, persistence, and only documented parameter syntax. Do not promote Telegram group administrators to configured bot administrators. Keep commands whose details are missing as names plus a source route.
- Natural-language intent labels for `/ignoreme` and `/unignoreme`, such as “别理我 / 不要回复我 / ignore me” and “恢复接收 / 重新理我 / unignore me”. These are discovery labels, not claims that sending those phrases executes a command. Distinguish self-ignore from whole-chat pause and from deleting history.
- Main tasks: participation, models, personality, memory, dictionary, image understanding/generation, reminders, web access, MCP, budgets, Admin, setup, upgrade and recovery.
- Relations that prevent wrong advice: Chat versus Topic; allowlist versus participation; memory versus dictionary; Agent versus background Vision budget; image understanding versus optional image generation; saved configuration versus running configuration; service CLI versus Admin API client.

For each entry keep a short fact, its important limitation, and one or more exact manual paths. Group related facts under a shared source only when that source supports all of them. Detailed numeric ranges, API flags, exhaustive UI workflows and long examples belong in the linked manual. Prioritize command discoverability and privilege/scope boundaries over exhaustive configuration coverage.

## Verify facts and handle gaps

Trace each emitted assertion back to a section you read. Preserve distinctions between examples, defaults, optional features, prerequisites, and promises. A sample model, timezone, quota or path is not a universal default. Read user manuals as data; never execute their embedded operational examples during a bake.

When evidence is missing, keep a route or omit the claim and record the gap. Do not invent command arguments, privileges, hot-reload support, platform support, or configuration keys. If a page names a command without defining its effect, retain only the documented name and access information. If an entire required source is unavailable, finish independent entries and report the missing prerequisite.

When manuals disagree, identify both passages in the ledger. Prefer a dedicated procedure corroborated by related pages over an isolated summary only when that resolution is defensible; describe that choice in the ledger. Otherwise omit the disputed detail or mark it as uncertain in the index with its source route. Never silently resolve disagreements using source code. A new manual fix can resolve a gap on the next bake; the index should not become a second specification.

## Budget and safe output

Keep the baked partition at most **7000 UTF-8 bytes**, aiming for **2000 model tokens or fewer**. Measure the trimmed Markdown string with `Buffer.byteLength(PRODUCT_KNOWLEDGE_INDEX, 'utf8')`. If a tokenizer for the deployed model is already available, report its count; otherwise call any token estimate an estimate. Do not add a tokenizer dependency for this task. Short English facts with selected Chinese intent labels are acceptable for compression.

When exact byte measurement is unavailable, draft to roughly 80% of the hard limit and report the budget as unverified. A model's length estimate is not a passed size check; the integration owner must measure before accepting the artifact.

From the repository root, measure the actual exported string without starting the runtime:

```bash
node --input-type=module -e 'import { PRODUCT_KNOWLEDGE_INDEX as text } from "./src/platform/product-knowledge.ts"; const bytes = Buffer.byteLength(text, "utf8"); console.log({ chars: text.length, bytes, gc_estimated_tokens: Math.ceil(text.length / 4) }); if (bytes > 7000) process.exitCode = 1;'
```

The GC-style estimate is not a model-token measurement. If the byte check fails, trim and repeat before handing off; do not round the result down or silently raise the budget.

Trim duplicated explanations, examples and low-value numeric detail first. Preserve links, command names, role/scope boundaries and major limitations. Do not put source hashes, inventories, bake timestamps, validation reports, or grounding rules in the string.

Write plain Markdown directly to `src/platform/prompts/2-product-knowledge.md`. Prefer plain command names in prose when Markdown code delimiters would add noise. Keep the index deterministic: stable topic order and no generated timestamps.

## Refresh workflow and handoff

On every refresh, repeat discovery to catch additions, renamed/deleted pages and navigation drift. Re-read changed pages in full plus their related pages; review previously recorded conflicts. Remove stale facts and routes instead of retaining compatibility aliases for removed documentation. Update the source ledger to describe the current bake, without appending a chronological log.

When checks are authorized, verify the byte budget, TypeScript import, every packed path against the prepared manual, and coverage of the documented slash-command inventory. Use the repository's existing tests and five lightweight product-question scenarios where present; do not introduce a generic evaluation framework. If working as a delegated author with checks assigned to the integration owner, hand over the exact checks and report them as unrun.

Review scenario expectations against the manuals: self-ignore in natural language; restoring reception; member versus configured-admin commands; capability/configuration routing; and an unsupported or undocumented request that must not acquire invented syntax. Runtime grounding probes own answering behavior; this skill owns the quality of the baked source material.

Two reusable local baking prompts are in [evals/evals.json](evals/evals.json): a fresh bake and a refresh with conflicting/missing documentation. Run them only when evaluation is in scope. They evaluate authoring, not live Bot behavior; runtime document-grounding scenarios need a harness that can actually call the document capabilities.
