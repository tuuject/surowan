import { DEPRECATED_CONFIG_FIELDS } from '../../../src/platform/config/deprecated.ts';
import { ConfigSchema } from '../../../src/platform/config/schema.ts';
import type { DocsLocale } from '../locales.ts';
import { type RuntimeDefault, runtimeDefaults } from './defaults.ts';
import {
  type FieldEntry,
  type SchemaNode,
  branchLimits,
  collectFields,
  hasFields,
  limitLabels,
  typeLabel,
} from './schema.ts';
import { FIELDS_TEXT, type FieldsText } from './text.ts';

/**
 * The generated configuration field reference: an index page with the scalar
 * top-level fields and the deprecated ones, plus one page per configuration
 * section.
 *
 * Split by section so an agent can read the part it needs: as one page the
 * reference outgrew the document tools' read limit. Every page stays below
 * `DOC_READ_MAX_BYTES`; `test/manual-pack.test.ts` enforces that, so a section
 * that outgrows the limit has to be split further rather than published.
 */

export const FIELDS_INDEX_PAGE = 'configuration/fields.md';
const FIELDS_SECTION_PAGE = /^configuration\/fields-[a-z0-9-]+\.md$/;

/** Whether the path is one generated per-section field reference page. */
export function isConfigFieldSectionPage(path: string): boolean {
  return FIELDS_SECTION_PAGE.test(path);
}

function frontmatter(title: string, description: string): string[] {
  // JSON quoting keeps a colon in a section name (`Configuration field reference: agent`)
  // from turning the YAML frontmatter into a mapping that Rspress refuses to parse.
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'editLink: false',
    'lastUpdated: false',
    '---',
    '',
  ];
}

interface DeprecatedEntry {
  readonly path: string;
  readonly section: string;
  readonly note: string;
}

/**
 * The deprecated-but-accepted fields and what replaces each one. They come from
 * `DEPRECATED_CONFIG_FIELDS`, so removing a field from the code removes it here,
 * plus `mcp.servers[].required`, which the MCP schema keeps for the same upgrade
 * compatibility reason without marking it `deprecated`.
 *
 * The same list feeds the index table and the per-section entries: one text, so
 * the two cannot disagree.
 */
function deprecatedEntries(text: FieldsText): readonly DeprecatedEntry[] {
  return [
    ...DEPRECATED_CONFIG_FIELDS.map((field) => ({
      path: field.path,
      section: field.section,
      note: text.deprecatedNotes[field.path] ?? field.replacement ?? text.noReplacement,
    })),
    { path: 'mcp.servers[].required', section: 'mcp', note: text.mcpRequiredNote },
  ];
}

/** One field as Markdown: heading, type, then every fact the Schema or the runtime carries. */
function fieldLines(
  lines: string[],
  text: FieldsText,
  entry: FieldEntry,
  defaults: ReadonlyMap<string, RuntimeDefault>,
  notes: ReadonlyMap<string, string>,
): void {
  const { schema } = entry;
  lines.push(
    `${'#'.repeat(Math.min(entry.depth + 1, 4))} \`${entry.name}\``,
    '',
    text.typeLine(typeLabel(schema), entry.required),
  );
  const deprecated = notes.get(entry.key);
  if (schema.deprecated === true || deprecated !== undefined) {
    lines.push(text.deprecated);
    if (deprecated !== undefined) {
      lines.push(text.deprecatedAction(deprecated));
    }
  }
  const limits = limitLabels(schema);
  if (limits.length > 0) {
    lines.push(text.limits(limits));
  }
  for (const branch of branchLimits(schema, text)) {
    lines.push(text.branchLimits(branch.branch, branch.limits));
  }
  if (entry.keyPattern !== undefined) {
    lines.push(text.keyPattern(entry.keyPattern));
  }
  if (schema.default !== undefined) {
    lines.push(text.schemaDefault(JSON.stringify(schema.default)));
  }
  const runtime = defaults.get(entry.key);
  if (runtime !== undefined) {
    if (runtime.absentSection !== undefined) {
      lines.push(text.runtimeDefaultWithoutSection(runtime.text, runtime.absentSection));
    } else {
      lines.push(runtime.kind === 'value' ? text.runtimeDefault(runtime.text) : text.runtimeDefaultRule(runtime.text));
    }
  }
  // A deprecated field's Schema note only repeats what the lines above say.
  if (schema.description !== undefined && schema.deprecated !== true) {
    lines.push(text.description(schema.description.trim()));
  }
  lines.push('');
}

function deprecatedTable(text: FieldsText, entries: readonly DeprecatedEntry[]): string[] {
  const lines = [
    `## ${text.deprecatedTitle}`,
    '',
    text.deprecatedIntro,
    '',
    `| ${text.deprecatedHeader.join(' | ')} |`,
    `| ${text.deprecatedHeader.map(() => '---').join(' | ')} |`,
  ];
  for (const entry of entries) {
    const file = `fields-${entry.section.replaceAll('_', '-')}.md`;
    lines.push(`| \`${entry.path}\` | ${entry.note} | ${text.sectionPageLink(entry.section, file)} |`);
  }
  lines.push('');
  return lines;
}

/**
 * The ConfigSchema reference, keyed by path below `content/<lang>/docs`.
 */
export function renderConfigFieldPages(lang: DocsLocale): ReadonlyMap<string, string> {
  const text = FIELDS_TEXT[lang];
  const defaults = runtimeDefaults(text);
  const deprecated = deprecatedEntries(text);
  const notes = new Map(deprecated.map((entry) => [entry.path, entry.note]));
  const schema: SchemaNode = ConfigSchema;
  const index = [
    ...frontmatter(text.indexTitle, text.indexDescription),
    `# ${text.indexTitle}`,
    '',
    text.indexIntro,
    ...text.notice,
    '',
    text.schemaLine,
    '',
  ];
  const pages = new Map<string, string>();
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const required = schema.required?.includes(key) ?? false;
    if (!hasFields(child)) {
      fieldLines(index, text, { name: key, key, schema: child, required, depth: 1 }, defaults, notes);
      continue;
    }
    const file = `fields-${key.replaceAll('_', '-')}.md`;
    fieldLines(index, text, { name: key, key, schema: child, required, depth: 1 }, defaults, notes);
    index.push(text.sectionLink(key, file), '');
    const page = [
      ...frontmatter(text.sectionTitle(key), text.sectionDescription(key)),
      `# ${text.sectionHeading(key)}`,
      '',
      text.sectionIntro,
      ...text.notice,
      '',
    ];
    for (const entry of collectFields(child, text, key, key, required, 1)) {
      fieldLines(page, text, entry, defaults, notes);
    }
    pages.set(`configuration/${file}`, `${page.join('\n')}\n`);
  }
  index.push(...deprecatedTable(text, deprecated));
  return new Map([[FIELDS_INDEX_PAGE, `${index.join('\n')}\n`], ...pages]);
}
