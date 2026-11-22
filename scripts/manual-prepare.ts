import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLED_MANUAL_DIR } from '../src/adapters/local-monolith/doc-spaces.ts';
import { DOC_INDEX_PATH, resolveDocPath } from '../src/platform/doc-spaces.ts';
import { FIELDS_INDEX_PAGE, isConfigFieldSectionPage } from './docs/config-fields/index.ts';
import { isGeneratedPage, renderGeneratedPages } from './docs/generated-pages.ts';
import { docsRoot, exampleNames, exampleSource, repositoryRoot } from './docs/prepare.ts';

/**
 * The docs site publishes zh (root) and en (`/en/`); the agent manual packs only
 * the English tree, so the runtime carries one manual instead of two copies of
 * every page.
 */
export const manualContentRoot = resolve(docsRoot, 'content/en/docs');

/** Prefix the site build swaps for its public base path; the runtime has no site to link to. */
const PUBLIC_LINK_PATTERN = /\[([^\]]*)\]\(__DOCS_BASE__\/([^)\s]*)\)/g;
/**
 * Images exist only on the published site (screenshots are shipped per locale),
 * and the offline manual is text-only, so every inline image keeps its caption.
 * Matching any destination also covers a link title and repo-relative paths.
 */
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\([^)]*\)/g;

type ExampleName = (typeof exampleNames)[number];

const EXAMPLE_DESCRIPTIONS: Record<ExampleName, { readonly language: string; readonly description: string }> = {
  'config.minimal.example.jsonc': {
    language: 'jsonc',
    description: 'The smallest configuration that starts the service with the Admin Panel and no Telegram.',
  },
  'config.example.jsonc': { language: 'jsonc', description: 'The complete runnable configuration example, verbatim.' },
  'system-prompt.example.md': { language: 'markdown', description: 'The persona prompt example, verbatim.' },
  'docker-compose.yml': { language: 'yaml', description: 'The Docker Compose deployment template, verbatim.' },
};

interface NavDirectory {
  readonly type: 'dir';
  readonly name: string;
  readonly label: string;
}

type NavEntry = string | NavDirectory;

interface PackedPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Packed content: hand-written pages with public links rewritten, or a generated page. */
  readonly content: string;
}

/**
 * One index item. A navigation directory nests its pages where the parent lists
 * it, instead of being appended after every direct page of the parent.
 */
type PackedBlock =
  | { readonly kind: 'page'; readonly page: PackedPage }
  | { readonly kind: 'group'; readonly label: string; readonly blocks: readonly PackedBlock[] };

interface PackedSection {
  readonly label: string;
  readonly blocks: readonly PackedBlock[];
}

export interface ManualPackResult {
  readonly outDir: string;
  readonly documents: readonly string[];
}

/**
 * Packs the docs site's Markdown into the runtime resource tree the document
 * tools read. Pages and sections come from the site's own `_meta.json`
 * navigation and frontmatter, so the agent index cannot drift from the published
 * manual: a page missing from navigation, or a navigation entry without a page,
 * fails the build.
 *
 * Generated pages come from the registry in `scripts/docs/generated-pages.ts`,
 * not from the sidebar: a page navigation lists is packed at that position, the
 * configuration field sections follow their index, and every other generated
 * page lands in "Other pages" instead of disappearing.
 */
export async function packManual(options: {
  readonly outDir: string;
  readonly contentRoot?: string;
  /** Overrides the generated-page registry; tests use it to prove discovery without a generator. */
  readonly generatedPages?: ReadonlyMap<string, string>;
}): Promise<ManualPackResult> {
  const outDir = resolve(options.outDir);
  if (outDir === repositoryRoot || repositoryRoot.startsWith(`${outDir}${sep}`)) {
    throw new Error(`Refusing to pack the manual into ${outDir}`);
  }
  const contentRoot = resolve(options.contentRoot ?? manualContentRoot);
  const generatedPages = options.generatedPages ?? renderGeneratedPages('en');
  const packed = new Set<string>();
  const rootPages: PackedPage[] = [];
  const sections: PackedSection[] = [];
  for (const entry of await readNavigation(contentRoot)) {
    if (typeof entry === 'string') {
      // The pack generates its own root index; the site's landing page is navigation for humans.
      if (entry === 'index') {
        continue;
      }
      const page = await readPage(contentRoot, `${entry}.md`, generatedPages);
      rootPages.push(page);
      packed.add(page.path);
      continue;
    }
    sections.push(await packSection(contentRoot, entry.name, entry.label, generatedPages, packed));
  }
  // Pages the site links but does not list in its sidebar still exist and stay
  // readable, in a clearly marked section instead of being dropped from the index.
  const unlisted = new Map<string, PackedPage>();
  for (const path of await listUnlistedPages(contentRoot, packed)) {
    unlisted.set(path, await readPage(contentRoot, path, generatedPages));
  }
  // Generated pages the sidebar does not reach are still part of the registry.
  for (const path of [...generatedPages.keys()].sort()) {
    if (!packed.has(path)) {
      unlisted.set(path, await readPage(contentRoot, path, generatedPages));
    }
  }
  // The site's downloadable examples are what its deployment pages tell readers
  // to start from, so the pack ships them as readable pages instead of dead links.
  const examples: PackedPage[] = [];
  for (const name of exampleNames) {
    examples.push(await readExample(name));
  }
  const packedSections: PackedSection[] = [
    ...sections,
    { label: 'Example files', blocks: examples.map(pageBlock) },
    ...(unlisted.size === 0 ? [] : [{ label: 'Other pages', blocks: [...unlisted.values()].map(pageBlock) }]),
  ];
  const documents = [...packedSections.flatMap((section) => flattenBlocks(section.blocks)), ...rootPages];

  await removeStaleDocuments(outDir);
  for (const page of documents) {
    const target = join(outDir, page.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page.content);
  }
  await writeFile(join(outDir, DOC_INDEX_PATH), renderIndex({ sections: packedSections, rootPages }));
  return { outDir, documents: documents.map((page) => page.path) };
}

/** One navigation directory, as blocks that keep nested directories in place. */
async function packSection(
  contentRoot: string,
  directory: string,
  label: string,
  generatedPages: ReadonlyMap<string, string>,
  packed: Set<string>,
): Promise<PackedSection> {
  const blocks: PackedBlock[] = [];
  for (const entry of await readNavigation(join(contentRoot, directory))) {
    if (typeof entry !== 'string') {
      const child = await packSection(contentRoot, `${directory}/${entry.name}`, entry.label, generatedPages, packed);
      blocks.push({ kind: 'group', label: child.label, blocks: child.blocks });
      continue;
    }
    const path = `${directory}/${entry}.md`;
    blocks.push({ kind: 'page', page: await readPage(contentRoot, path, generatedPages) });
    packed.add(path);
    // The sidebar lists only the generated reference index; its section pages follow it.
    if (path === FIELDS_INDEX_PAGE) {
      for (const sectionPath of [...generatedPages.keys()].filter(isConfigFieldSectionPage).sort()) {
        if (!packed.has(sectionPath)) {
          blocks.push({ kind: 'page', page: await readPage(contentRoot, sectionPath, generatedPages) });
          packed.add(sectionPath);
        }
      }
    }
  }
  return { label, blocks };
}

async function readNavigation(directory: string): Promise<readonly NavEntry[]> {
  const path = join(directory, '_meta.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`Documentation navigation is missing or invalid: ${path}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Documentation navigation is not an array: ${path}`);
  }
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        throw new Error(`Documentation navigation contains an empty entry: ${path}`);
      }
      continue;
    }
    if (!isNavDirectory(entry)) {
      throw new Error(`Documentation navigation contains an unsupported entry: ${path}`);
    }
    if (!isChildSegment(entry.name)) {
      throw new Error(`Documentation navigation directory must name a single child segment: ${entry.name} (${path})`);
    }
  }
  const navigation: readonly NavEntry[] = parsed;
  return navigation;
}

/**
 * A navigation directory names exactly one child of the directory that lists it.
 * `.`/`..` and names with a separator would make the walk climb out of the tree.
 */
export function isChildSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

/** Type guard: keeps the navigation contract checked before any entry is treated as a directory. */
function isNavDirectory(entry: unknown): entry is NavDirectory {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'dir' &&
    'name' in entry &&
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    'label' in entry &&
    typeof entry.label === 'string' &&
    entry.label.length > 0
  );
}

async function readPage(
  contentRoot: string,
  path: string,
  generatedPages: ReadonlyMap<string, string>,
): Promise<PackedPage> {
  resolveDocPath(path);
  const content = generatedPages.get(path);
  if (content !== undefined) {
    // Regenerated from the ConfigSchema the runtime validates: a Docker build
    // context has no docs:prepare output to copy.
    return { path, content: rewritePublicLinks(content, path), ...parseFrontmatter(content, path) };
  }
  if (isGeneratedPage(path)) {
    throw new Error(`The generated-page registry has no page for ${path}`);
  }
  const text = await readFile(resolve(contentRoot, path), 'utf8').catch(() => {
    throw new Error(`Manual page listed in navigation does not exist: ${path}`);
  });
  return { path, content: rewritePublicLinks(text, path), ...parseFrontmatter(text, path) };
}

function examplePath(name: ExampleName): string {
  return `examples/${name.endsWith('.md') ? name : `${name}.md`}`;
}

/** One downloadable example as a Markdown page that quotes the file verbatim. */
async function readExample(name: ExampleName): Promise<PackedPage> {
  const source = await readFile(exampleSource(name), 'utf8');
  const { language, description } = EXAMPLE_DESCRIPTIONS[name];
  const longestFence = Math.max(2, ...[...source.matchAll(/`{3,}/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestFence + 1);
  const content = [
    `# ${name}`,
    '',
    `${description} The documentation site offers \`${name}\` for download; below is the same file verbatim.`,
    '',
    `${fence}${language}`,
    source.endsWith('\n') ? source.slice(0, -1) : source,
    fence,
    '',
  ].join('\n');
  return { path: examplePath(name), title: `Example file ${name}`, description, content };
}

/**
 * Rewrites what only resolves on the published site. Examples point at their
 * packed pages, every inline image becomes its caption, and other public
 * resources (JSON Schema, llms.txt) keep their label but lose the link, since the
 * runtime cannot serve them.
 */
function rewritePublicLinks(text: string, pagePath: string): string {
  const rewritten = text
    .replace(MARKDOWN_IMAGE_PATTERN, (_image, alt: string) => (alt.trim() ? `(Screenshot: ${alt})` : '(Screenshot)'))
    .replace(PUBLIC_LINK_PATTERN, (_link, label: string, target: string) => {
      const example = exampleNames.find((name) => target === `examples/${name}`);
      if (example === undefined) {
        return label;
      }
      return `[${label}](${posix.relative(posix.dirname(pagePath), examplePath(example))})`;
    });
  if (rewritten.includes('__DOCS_BASE__')) {
    throw new Error(`Manual page has a public-resource reference the pack cannot rewrite: ${pagePath}`);
  }
  return rewritten;
}

/** Markdown sources absent from navigation, which the pack still ships and indexes. */
async function listUnlistedPages(contentRoot: string, listed: ReadonlySet<string>): Promise<readonly string[]> {
  const files = (await readdir(contentRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(contentRoot, join(entry.parentPath, entry.name)).split(sep).join('/'));
  // Generated pages left on disk by docs:prepare are packed fresh from the registry, never from disk.
  return files
    .filter((path) => path !== 'index.md' && !listed.has(path) && !isGeneratedPage(path))
    .sort((left, right) => left.localeCompare(right));
}

/** Removes documents left behind by a previous pack; only Markdown is generated here. */
async function removeStaleDocuments(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      await rm(join(entry.parentPath, entry.name));
    }
  }
}

/** A frontmatter scalar: JSON quoting is decoded, a plain scalar is already the value. */
function parseFrontmatterValue(raw: string, label: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Manual page has an invalid quoted frontmatter value: ${label}`);
  }
  if (typeof parsed !== 'string') {
    throw new Error(`Manual page has a non-string frontmatter value: ${label}`);
  }
  return parsed;
}

function parseFrontmatter(text: string, label: string): { title: string; description: string } {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error(`Manual page is missing frontmatter: ${label}`);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing === -1) {
    throw new Error(`Manual page has unterminated frontmatter: ${label}`);
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`Manual page has an invalid frontmatter line: ${label}`);
    }
    fields[line.slice(0, separator).trim()] = parseFrontmatterValue(line.slice(separator + 1), label);
  }
  const title = fields.title ?? '';
  const description = fields.description ?? '';
  if (title.length === 0 || description.length === 0) {
    throw new Error(`Manual page frontmatter must declare title and description: ${label}`);
  }
  return { title, description };
}

function pageBlock(page: PackedPage): PackedBlock {
  return { kind: 'page', page };
}

/** Every page of a block tree, in reading order. */
function flattenBlocks(blocks: readonly PackedBlock[]): PackedPage[] {
  return blocks.flatMap((block) => (block.kind === 'page' ? [block.page] : flattenBlocks(block.blocks)));
}

/** The compact Markdown index the document tools return; navigation order is reading order. */
function renderIndex(options: {
  readonly sections: readonly PackedSection[];
  readonly rootPages: readonly PackedPage[];
}): string {
  const total = options.sections.reduce((count, section) => count + flattenBlocks(section.blocks).length, 0);
  const lines = [
    '# Surowan User Manual',
    '',
    `This index is generated by the build script from the documentation site's \`_meta.json\` navigation and each page's frontmatter, and ships with the running version: ${total + options.rootPages.length} pages.`,
    '',
    'Use `read_document` to read a page in this space (`space: "manual"`, `path` relative to this index). When a page links another page relatively, pass the current page path as `base`. Read only the pages the current task needs instead of the whole manual.',
    '',
    'These documents ship with the running version and may differ from the version this user deployed; where behaviour differs, the version they run wins.',
    '',
  ];
  const blank = (): void => {
    if (lines[lines.length - 1] !== '') {
      lines.push('');
    }
  };
  const blocks = (entries: readonly PackedBlock[], depth: number): void => {
    const indent = '  '.repeat(depth - 1);
    for (const entry of entries) {
      if (entry.kind === 'page') {
        lines.push(`${indent}- [${entry.page.title}](${entry.page.path}): ${entry.page.description}`);
        continue;
      }
      // A nested navigation directory keeps its position and its own heading level.
      if (flattenBlocks(entry.blocks).length === 0) {
        continue;
      }
      blank();
      lines.push(`${'#'.repeat(2 + depth)} ${entry.label}`);
      blank();
      blocks(entry.blocks, depth + 1);
      blank();
    }
  };
  const section = (label: string, entries: readonly PackedBlock[]): void => {
    if (entries.length === 0) {
      return;
    }
    lines.push(`## ${label}`);
    blank();
    blocks(entries, 1);
    blank();
  };
  section('Overview', options.rootPages.map(pageBlock));
  for (const entry of options.sections) {
    section(entry.label, entry.blocks);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await packManual({ outDir: BUNDLED_MANUAL_DIR });
  console.log(`Packed ${result.documents.length} manual documents into ${result.outDir}`);
}
