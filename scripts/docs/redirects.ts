import { renderConfigFieldPages } from './config-fields/index.ts';

/**
 * The pre-reorganization documentation tree was deleted, so every published
 * `docs/` URL maps to its replacement here. Both languages come from one zh
 * tree, which is why only the root (zh) paths need redirects: the English pages
 * never had deep links before the reorganization.
 *
 * The file is generated rather than committed because the rules carry the
 * deployment base (`DOCS_BASE_PATH`), and it is written to the site's shared
 * public directory: Cloudflare Workers static assets read `_redirects` from the
 * asset root.
 */

/** Old path below `docs/` → new path below `docs/` (design doc §6). */
const MOVES: readonly (readonly [from: string, to: string])[] = [
  ['start/quick-start', 'guides/installation'],
  ['start/installation', 'guides/installation'],
  ['start/agent-assisted', 'guides/agent-assisted'],
  ['configure/admin-agent-pairing', 'guides/agent-assisted'],
  ['reference/cli-surowan-utils-skill', 'guides/agent-assisted'],
  ['configure/config-file', 'configuration/index'],
  ['configure/telegram', 'guides/first-bot'],
  ['configure/models', 'guides/models'],
  ['configure/admin', 'guides/admin'],
  ['configure/admin-keychain', 'guides/admin'],
  ['configure/admin-api-keys', 'guides/admin'],
  ['configure/admin-harness-tuning', 'guides/tuning'],
  ['configure/admin-invocation-review', 'guides/tuning'],
  ['guides/budgets', 'guides/tuning'],
  ['guides/proactive-replies', 'guides/tuning'],
  ['guides/entry-gate', 'guides/tuning'],
  ['configure/admin-developer', 'configuration/developer'],
  ['configure/admin-prompts', 'guides/first-persona'],
  ['guides/personality', 'guides/first-persona'],
  ['configure/admin-invocation-replay', 'developer/replay'],
  ['configure/mcp-server', 'developer/mcp-server'],
  ['guides/participation', 'guides/chats'],
  ['guides/per-chat', 'guides/chats'],
  ['guides/memory', 'guides/knowledge'],
  ['guides/dictionary', 'guides/knowledge'],
  ['guides/extensions', 'guides/mcp'],
  ['operations/upgrade', 'guides/maintenance'],
  ['operations/backup-restore', 'guides/maintenance'],
  ['operations/troubleshooting', 'guides/troubleshooting'],
  ['reference/config', 'configuration/lifecycle'],
  ['reference/fields', 'configuration/fields'],
  ['reference/cli', 'developer/service-cli'],
  ['reference/cli-surowan-utils', 'developer/client-cli'],
  ['reference/cli-surowan-utils-reference', 'developer/client-cli'],
];

/**
 * Field-reference sections the pre-reorganization generator published at
 * `reference/fields-<slug>`, frozen at `86db554f`. Following the live schema
 * would silently drop the published URL of a retired or renamed section, so this
 * list only ever grows by deliberate edits.
 */
export const LEGACY_FIELD_SLUGS = [
  'admin',
  'agent',
  'developer',
  'dictionary',
  'image',
  'mcp',
  'models-dev',
  'paths',
  'providers',
  'retention',
  'telegram',
  'tool-model',
  'vision',
  'web-fetch',
  'web-search',
] as const;

export type LegacyFieldSlug = (typeof LEGACY_FIELD_SLUGS)[number];

/**
 * One move per frozen legacy section. A section that still exists keeps its own
 * page; a retired one redirects to the field reference index instead of a 404.
 */
export function fieldPageMoves(available: ReadonlySet<string>): readonly (readonly [from: string, to: string])[] {
  return LEGACY_FIELD_SLUGS.map(
    (slug) =>
      [
        `reference/fields-${slug}`,
        available.has(slug) ? `configuration/fields-${slug}` : 'configuration/fields',
      ] as const,
  );
}

/** Section slugs the current generator publishes, for resolving the frozen list. */
function generatedFieldSlugs(): ReadonlySet<string> {
  return new Set(
    [...renderConfigFieldPages('zh').keys()]
      .map((path) => /^configuration\/fields-([a-z0-9-]+)\.md$/.exec(path)?.[1])
      .filter((slug): slug is string => slug !== undefined),
  );
}

export interface RedirectRule {
  /** Absolute path on the deployed site, including the base. */
  readonly from: string;
  /** Absolute path of the replacement page, including the base. */
  readonly to: string;
}

interface TargetForms {
  /** The extensionless URL; a directory index is reachable through its directory. */
  readonly bare: string;
  readonly html: string;
  readonly md: string;
}

/**
 * The three published forms of one page path. A directory index page keeps the
 * `index` file name for its `.html` and `.md` forms.
 */
function targetForms(path: string): TargetForms {
  const bare = path.endsWith('/index') ? path.slice(0, -'index'.length) : path;
  return { bare, html: `${path}.html`, md: `${path}.md` };
}

export function redirectRules(base: string): readonly RedirectRule[] {
  const prefix = `${base}docs/`;
  const rules: RedirectRule[] = [];
  for (const [from, to] of [...MOVES, ...fieldPageMoves(generatedFieldSlugs())]) {
    const forms = targetForms(to);
    rules.push(
      { from: `${prefix}${from}`, to: `${prefix}${forms.bare}` },
      { from: `${prefix}${from}.html`, to: `${prefix}${forms.html}` },
      { from: `${prefix}${from}.md`, to: `${prefix}${forms.md}` },
    );
  }
  return rules;
}

/** Cloudflare Workers static assets `_redirects`: one `from to 301` rule per line. */
export function renderRedirects(base: string): string {
  return `${redirectRules(base)
    .map((rule) => `${rule.from} ${rule.to} 301`)
    .join('\n')}\n`;
}
