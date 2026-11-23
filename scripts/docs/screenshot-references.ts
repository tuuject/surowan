/**
 * Cross-checks the screenshots the documentation pages embed against the
 * manifest that names them.
 *
 * `screenshot-assets.ts` proves the committed asset set is complete and real;
 * it cannot see whether a page uses it. This module closes that loop:
 *
 * - a page may only reference `__DOCS_BASE__/screenshots/<id>.<locale>.light.png`,
 *   with the Chinese tree on `zh-CN` and the English tree on `en` — a crossed
 *   pair would ship Chinese pixels to English readers;
 * - the id must be a manifest scenario, and the file must exist;
 * - every alt text must be non-empty: the offline manual replaces an image with
 *   `(Screenshot: <alt>)`, so an empty alt loses the caption there;
 * - every manifest scenario must appear on at least one page of *each* locale,
 *   otherwise a captured pair is dead weight (or one locale silently lost it);
 * - no `<!-- screenshot: … -->` placeholder may survive.
 *
 * Pages are parsed as CommonMark (and MDX, where the same parser sees JSX as raw
 * HTML): only rendered `image`/`imageReference` nodes count, so an image that
 * sits in a code sample or an HTML comment cannot keep a scenario "covered", and
 * a title, an angle-bracket destination or a reference-style definition cannot
 * slip past the locale check. A raw `<img>` pointing at a screenshot is an error
 * because the pack turns only Markdown images into captions.
 *
 * `scripts/docs/verify.ts` runs it on the source tree, and
 * `test/docs/screenshot-references.test.ts` runs it on fixtures and on the real
 * tree.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { type ScreenshotLocale, SCREENSHOTS_DIRECTORY } from './screenshot-assets.ts';

/** `apps/docs/content`: the tree that holds both locales and the shared public files. */
export const DOCS_CONTENT_DIRECTORY = resolve(import.meta.dirname, '..', '..', 'apps', 'docs', 'content');

/** The content directory of a locale, and the locale its images must be in. */
export const PAGE_LOCALES: readonly { readonly directory: string; readonly locale: ScreenshotLocale }[] = [
  { directory: 'zh', locale: 'zh-CN' },
  { directory: 'en', locale: 'en' },
];

const SCREENSHOT_DESTINATION_PREFIX = '__DOCS_BASE__/screenshots/';
const SCREENSHOT_FILE_PATTERN = /^([a-z0-9-]+\/[a-z0-9-]+)\.([A-Za-z-]+)\.light\.png$/;
const PLACEHOLDER_MARKER = '<!-- screenshot:';
const RAW_IMAGE_PATTERN = /<img\b/i;
/** Both route extensions the site builds; `.mdx` parses the same way for our purposes. */
const PAGE_EXTENSION_PATTERN = /\.mdx?$/;

type MarkdownTree = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownTree['children'][number];

export interface ScreenshotReferenceReport {
  readonly ok: boolean;
  /** One line per problem; empty when `ok` is true. */
  readonly errors: readonly string[];
  /** Scenario ids referenced by at least one page, per locale. */
  readonly referenced: Readonly<Record<ScreenshotLocale, readonly string[]>>;
  readonly pageCount: number;
  readonly referenceCount: number;
}

export interface CheckReferencesOptions {
  /** Defaults to `apps/docs/content`. */
  readonly contentRoot?: string;
  /** Defaults to `apps/docs/content/public/screenshots`. */
  readonly screenshotsDirectory?: string;
}

/** One page being checked, with the accumulator it reports into. */
interface PageScan {
  readonly text: string;
  /** `<locale dir>/<page path>`, as errors name it. */
  readonly label: string;
  readonly localeDirectory: string;
  readonly locale: ScreenshotLocale;
  readonly screenshotsDirectory: string;
  readonly manifestIds: ReadonlySet<string>;
  readonly errors: string[];
  readonly referenced: Record<ScreenshotLocale, Set<string>>;
  referenceCount: number;
}

async function pageFiles(directory: string, base: string = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const pages: string[] = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      pages.push(...(await pageFiles(path, base)));
    } else if (PAGE_EXTENSION_PATTERN.test(entry.name)) {
      pages.push(relative(base, path).split(sep).join('/'));
    }
  }
  return pages.sort();
}

function childrenOf(node: MarkdownNode): readonly MarkdownNode[] {
  return 'children' in node ? node.children : [];
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

/** The same walk over a parsed document; the root itself carries no span. */
function walkTree(tree: MarkdownTree, visit: (node: MarkdownNode) => void): void {
  for (const child of tree.children) {
    walk(child, visit);
  }
}

/** The source text of one node, for an error that shows what the page wrote. */
function slice(text: string, node: MarkdownNode): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? '' : text.slice(start, end);
}

function lineOf(node: MarkdownNode): number {
  return node.position?.start.line ?? 1;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** One rendered image: it must be this locale's file, a known scenario and really there. */
async function checkImage(scan: PageScan, destination: string, alt: string, line: number): Promise<void> {
  if (!destination.includes('/screenshots/')) {
    return;
  }
  const where = `${scan.label}:${String(line)}`;
  if (!destination.startsWith(SCREENSHOT_DESTINATION_PREFIX)) {
    scan.errors.push(
      `${where}: screenshot must be referenced through ${SCREENSHOT_DESTINATION_PREFIX}: ${destination}`,
    );
    return;
  }
  scan.referenceCount += 1;
  const file = destination.slice(SCREENSHOT_DESTINATION_PREFIX.length);
  const parsed = SCREENSHOT_FILE_PATTERN.exec(file);
  if (!parsed) {
    scan.errors.push(`${where}: screenshot file name is not <topic>/<state>.<locale>.light.png: ${file}`);
    return;
  }
  const [, id = '', fileLocale = ''] = parsed;
  if (fileLocale !== scan.locale) {
    scan.errors.push(
      `${where}: ${scan.localeDirectory} pages must embed *.${scan.locale}.light.png, not the ${fileLocale} file`,
    );
  }
  if (!scan.manifestIds.has(id)) {
    scan.errors.push(`${where}: screenshot is not a manifest scenario: ${id}`);
    return;
  }
  if (alt.trim().length === 0) {
    scan.errors.push(`${where}: screenshot needs an alt text; the offline manual prints it as the caption: ${id}`);
  }
  if (!(await isFile(join(scan.screenshotsDirectory, file)))) {
    scan.errors.push(`${where}: missing screenshot file: ${file}`);
  }
  scan.referenced[scan.locale].add(id);
}

/** Checks one page: rendered images, reference definitions, placeholders and raw `<img>`. */
async function checkPage(scan: PageScan): Promise<void> {
  const tree = fromMarkdown(scan.text);
  const definitions = new Map<string, string>();
  walkTree(tree, (node) => {
    if (node.type === 'definition') {
      definitions.set(node.identifier, node.url);
    }
  });

  const images: { readonly destination: string; readonly alt: string; readonly line: number }[] = [];
  walkTree(tree, (node) => {
    if (node.type === 'image') {
      images.push({ destination: node.url, alt: node.alt ?? '', line: lineOf(node) });
      return;
    }
    if (node.type === 'imageReference') {
      // Only a definition makes a reference an image; an unresolved one renders
      // as literal text, so it references nothing.
      const destination = definitions.get(node.identifier);
      if (destination !== undefined) {
        images.push({ destination, alt: node.alt ?? '', line: lineOf(node) });
      }
      return;
    }
    if (node.type !== 'html') {
      return;
    }
    const raw = slice(scan.text, node);
    const where = `${scan.label}:${String(lineOf(node))}`;
    if (raw.includes(PLACEHOLDER_MARKER)) {
      scan.errors.push(`Screenshot placeholder left in ${where}`);
    }
    if (RAW_IMAGE_PATTERN.test(raw) && raw.includes('/screenshots/')) {
      scan.errors.push(`${where}: write the screenshot as Markdown, not raw <img>: ${raw.trim()}`);
    }
  });
  for (const image of images) {
    await checkImage(scan, image.destination, image.alt, image.line);
  }
}

/**
 * Checks every image reference and the orphan rule. Returns a report instead of
 * throwing so the verifier and the test can print every problem at once.
 */
export async function checkScreenshotReferences(
  options: CheckReferencesOptions = {},
): Promise<ScreenshotReferenceReport> {
  const contentRoot = resolve(options.contentRoot ?? DOCS_CONTENT_DIRECTORY);
  const screenshotsDirectory = resolve(options.screenshotsDirectory ?? SCREENSHOTS_DIRECTORY);
  const errors: string[] = [];
  const referenced: Record<ScreenshotLocale, Set<string>> = { 'zh-CN': new Set(), en: new Set() };
  let pageCount = 0;

  let manifestIds: ReadonlySet<string>;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(screenshotsDirectory, 'manifest.json'), 'utf8'));
    const scenarios = (manifest as { scenarios?: { id?: unknown }[] }).scenarios;
    if (!Array.isArray(scenarios)) {
      throw new Error('manifest.json has no scenarios array');
    }
    manifestIds = new Set(scenarios.map((scenario) => String(scenario.id)));
  } catch (error) {
    return {
      ok: false,
      errors: [`Cannot read the screenshot manifest: ${error instanceof Error ? error.message : String(error)}`],
      referenced: { 'zh-CN': [], en: [] },
      pageCount: 0,
      referenceCount: 0,
    };
  }

  let referenceCount = 0;
  for (const { directory, locale } of PAGE_LOCALES) {
    for (const page of await pageFiles(join(contentRoot, directory))) {
      pageCount += 1;
      const scan: PageScan = {
        text: await readFile(join(contentRoot, directory, page), 'utf8'),
        label: `${directory}/${page}`,
        localeDirectory: directory,
        locale,
        screenshotsDirectory,
        manifestIds,
        errors,
        referenced,
        referenceCount: 0,
      };
      await checkPage(scan);
      referenceCount += scan.referenceCount;
    }
  }

  for (const { directory, locale } of PAGE_LOCALES) {
    const used = referenced[locale];
    for (const id of [...manifestIds].sort()) {
      if (!used.has(id)) {
        errors.push(`Screenshot is on no ${directory} page: ${id} (add it to a page or drop the scenario)`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    referenced: { 'zh-CN': [...referenced['zh-CN']].sort(), en: [...referenced.en].sort() },
    pageCount,
    referenceCount,
  };
}
