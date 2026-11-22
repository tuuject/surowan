import { ConfigSchema } from '../../src/platform/config/schema.ts';
import type { DocsLocale } from './locales.ts';

/**
 * Pages the documentation site generates instead of storing them in Git. The
 * site is generated for every locale, the Bot manual packs the generated `en`
 * pages, and `verify.ts` uses the same predicates to tell generated pages from
 * hand-written ones (generated pages hide the edit link and the Git timestamp).
 *
 * A new generated page set is one entry in `generatedPageSets`: a path predicate
 * over `content/<lang>/docs` plus a renderer that returns the pages for a locale.
 */

export interface GeneratedPageSet {
  /** Stable name for error messages. */
  readonly id: string;
  /** Whether this set generates the page at `path`, relative to `content/<lang>/docs`. */
  readonly matches: (path: string) => boolean;
  /** Every page of this set for one locale, keyed by the same relative path. */
  readonly render: (lang: DocsLocale) => ReadonlyMap<string, string>;
}

export const FIELDS_INDEX_PAGE = 'configuration/fields.md';
const FIELDS_SECTION_PAGE = /^configuration\/fields-[a-z0-9-]+\.md$/;

/** Whether the path is one generated per-section field reference page. */
export function isConfigFieldSectionPage(path: string): boolean {
  return FIELDS_SECTION_PAGE.test(path);
}

interface SchemaNode {
  type?: string;
  const?: unknown;
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  required?: string[] | undefined;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  uniqueItems?: boolean;
  deprecated?: boolean;
}

interface FieldsText {
  readonly indexTitle: string;
  readonly indexDescription: string;
  readonly indexIntro: string;
  readonly sectionTitle: (section: string) => string;
  readonly sectionHeading: (section: string) => string;
  readonly sectionDescription: (section: string) => string;
  readonly sectionIntro: string;
  readonly notice: readonly string[];
  readonly typeLine: (type: string, required: boolean) => string;
  readonly deprecated: string;
  readonly limits: (limits: readonly string[]) => string;
  readonly sectionLink: (section: string, file: string) => string;
  readonly schemaLine: string;
  readonly patternKey: string;
  readonly unionBranch: (index: number) => string;
}

const FIELDS_TEXT: Record<DocsLocale, FieldsText> = {
  zh: {
    indexTitle: '配置字段参考',
    indexDescription: '从当前源码 ConfigSchema 生成的字段类型、必填性与取值限制，按配置段分页。',
    indexIntro: '本页与各配置段的分页由同一提交的 ConfigSchema 自动生成。',
    sectionTitle: (section) => `配置字段参考：${section}`,
    sectionHeading: (section) => `配置字段参考：\`${section}\``,
    sectionDescription: (section) => `从当前源码 ConfigSchema 生成的 ${section} 段字段类型、必填性与取值限制。`,
    sectionIntro: '本页由同一提交的 ConfigSchema 自动生成，属于[配置字段参考](fields.md)。',
    notice: [
      '**必填是相对于所在对象而言**；可选对象未启用时不要求它的子字段。',
      '可选不等于有默认值，类型合法也不等于通过跨字段语义校验。默认行为、热更新与覆盖关系请读[配置生命周期](lifecycle.md)。',
    ],
    typeLine: (type, required) => `类型：\`${type}\`；${required ? '必填' : '可选'}。`,
    deprecated: '**已废弃**：字段仍被接受但无任何效果，请删除。',
    limits: (limits) => `限制：${limits.map((limit) => `\`${limit}\``).join('，')}。`,
    sectionLink: (section, file) => `字段见[\`${section}\` 段字段参考](${file})。`,
    schemaLine: '[下载 JSON Schema](__DOCS_BASE__/config.schema.json)。日常配置优先从[配置文件入门](index.md)开始。',
    patternKey: '名称',
    unionBranch: (index) => `（分支 ${index + 1}）`,
  },
  en: {
    indexTitle: 'Configuration field reference',
    indexDescription:
      'Field types, required fields and value limits generated from the ConfigSchema in this commit, split by configuration section.',
    indexIntro: 'This page and the per-section pages are generated from the ConfigSchema of the same commit.',
    sectionTitle: (section) => `Configuration field reference: ${section}`,
    sectionHeading: (section) => `Configuration field reference: \`${section}\``,
    sectionDescription: (section) =>
      `Field types, required fields and value limits of the ${section} section, generated from the ConfigSchema in this commit.`,
    sectionIntro:
      'This page is generated from the ConfigSchema of the same commit and belongs to the [configuration field reference](fields.md).',
    notice: [
      '**"Required" is relative to the enclosing object**: when an optional object is absent, its child fields are not required.',
      'Optional does not mean "has a default", and passing the type check does not mean the cross-field rules pass. Read [configuration lifecycle](lifecycle.md) for defaults, hot application and overrides.',
    ],
    typeLine: (type, required) => `Type: \`${type}\`; ${required ? 'required' : 'optional'}.`,
    deprecated: '**Deprecated**: the field is still accepted but has no effect; remove it.',
    limits: (limits) => `Limits: ${limits.map((limit) => `\`${limit}\``).join(', ')}.`,
    sectionLink: (section, file) => `See [the \`${section}\` field reference](${file}).`,
    schemaLine:
      '[Download the JSON Schema](__DOCS_BASE__/config.schema.json). For everyday configuration start from [configuration file basics](index.md).',
    patternKey: 'name',
    unionBranch: (index) => ` (branch ${index + 1})`,
  },
};

function typeLabel(schema: SchemaNode): string {
  if ('const' in schema) {
    return JSON.stringify(schema.const);
  }
  if (schema.anyOf) {
    return schema.anyOf.map(typeLabel).join(' / ');
  }
  if (!schema.type) {
    throw new Error('Unsupported configuration schema node');
  }
  return schema.type;
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

function fieldHeading(
  lines: string[],
  text: FieldsText,
  schema: SchemaNode,
  name: string,
  required: boolean,
  depth: number,
): void {
  const constraints = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'minLength',
    'minItems',
    'maxItems',
    'pattern',
    'uniqueItems',
  ] as const;
  const limits = constraints
    .filter((key) => schema[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(schema[key])}`);
  lines.push(`${'#'.repeat(Math.min(depth + 1, 4))} \`${name}\``, '', text.typeLine(typeLabel(schema), required), '');
  if (schema.deprecated === true) {
    lines.push(text.deprecated, '');
  }
  if (limits.length) {
    lines.push(text.limits(limits), '');
  }
}

function walk(
  lines: string[],
  text: FieldsText,
  schema: SchemaNode,
  name: string,
  required: boolean,
  depth: number,
): void {
  fieldHeading(lines, text, schema, name, required, depth);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    walk(lines, text, child, `${name}.${key}`, schema.required?.includes(key) ?? false, depth + 1);
  }
  for (const child of Object.values(schema.patternProperties ?? {})) {
    walk(lines, text, child, `${name}.<${text.patternKey}>`, false, depth + 1);
  }
  if (schema.items) {
    walk(lines, text, schema.items, `${name}[]`, true, depth + 1);
  }
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    if (child.type === 'object') {
      walk(lines, text, child, `${name}${text.unionBranch(index)}`, required, depth + 1);
    }
  }
}

/** Whether a top-level field has fields of its own, and so a page of its own. */
function hasFields(schema: SchemaNode): boolean {
  return (
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.items !== undefined ||
    (schema.anyOf ?? []).some((child) => child.type === 'object')
  );
}

/**
 * The ConfigSchema reference, keyed by path below `content/<lang>/docs`: an index
 * with the scalar top-level fields, plus one page per configuration section.
 * Split so the agent can read the one section it needs: as a single page the
 * reference outgrew the document tools' read limit.
 */
export function renderConfigFieldPages(lang: DocsLocale): ReadonlyMap<string, string> {
  const text = FIELDS_TEXT[lang];
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
      walk(index, text, child, key, required, 1);
      continue;
    }
    const file = `fields-${key.replaceAll('_', '-')}.md`;
    fieldHeading(index, text, child, key, required, 1);
    index.push(text.sectionLink(key, file), '');
    const page = [
      ...frontmatter(text.sectionTitle(key), text.sectionDescription(key)),
      `# ${text.sectionHeading(key)}`,
      '',
      text.sectionIntro,
      ...text.notice,
      '',
    ];
    walk(page, text, child, key, required, 1);
    pages.set(`configuration/${file}`, `${page.join('\n')}\n`);
  }
  return new Map([[FIELDS_INDEX_PAGE, `${index.join('\n')}\n`], ...pages]);
}

const configFieldsPageSet: GeneratedPageSet = {
  id: 'config-fields',
  matches: (path) => path === FIELDS_INDEX_PAGE || isConfigFieldSectionPage(path),
  render: renderConfigFieldPages,
};

export const generatedPageSets: readonly GeneratedPageSet[] = [configFieldsPageSet];

/** Whether `path` below `content/<lang>/docs` is generated rather than hand-written. */
export function isGeneratedPage(path: string): boolean {
  return generatedPageSets.some((pages) => pages.matches(path));
}

/** Every generated page for one locale, checked for two sets claiming one path. */
export function renderGeneratedPages(lang: DocsLocale): ReadonlyMap<string, string> {
  const pages = new Map<string, string>();
  for (const set of generatedPageSets) {
    for (const [path, content] of set.render(lang)) {
      if (typeof path !== 'string' || !set.matches(path)) {
        throw new Error(`Generated page set ${set.id} rendered an undeclared path: ${path}`);
      }
      if (pages.has(path)) {
        throw new Error(`Two generated page sets claim the same page: ${path}`);
      }
      pages.set(path, content);
    }
  }
  return pages;
}
