import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isGeneratedPage, renderGeneratedPages } from './generated-pages.ts';
import type { DocsLocale } from './locales.ts';

export interface MetaFileEntry {
  readonly type: 'file';
  readonly name: string;
  readonly label?: string;
}

export interface MetaDirEntry {
  readonly type: 'dir';
  readonly name: string;
  readonly label: string;
  readonly collapsible?: boolean;
  readonly collapsed?: boolean;
}

/** Rspress-native label that splits one directory's sidebar into titled runs without moving pages. */
export interface MetaSectionHeaderEntry {
  readonly type: 'section-header';
  readonly label: string;
}

export type MetaEntry = string | MetaFileEntry | MetaDirEntry | MetaSectionHeaderEntry;

export interface DocsNavItem {
  readonly text: string;
  readonly link: string;
  readonly activeMatch?: string;
  readonly position?: 'left' | 'right';
}

export interface DocsSidebarItem {
  readonly text: string;
  readonly link: string;
}

export interface DocsSidebarGroup {
  readonly text: string;
  readonly link?: string;
  readonly items: DocsSidebarEntry[];
  readonly collapsible?: boolean;
  readonly collapsed?: boolean;
}

export interface DocsSidebarSectionHeader {
  readonly sectionHeaderText: string;
}

export type DocsSidebarEntry = DocsSidebarItem | DocsSidebarGroup | DocsSidebarSectionHeader;

export interface DocsLocaleNavigation {
  readonly nav: DocsNavItem[];
  readonly sidebar: Record<string, DocsSidebarEntry[]>;
}

/**
 * A navigation entry names exactly one child of the directory that lists it.
 * `.`/`..` and names with a separator would make the walk climb out of the tree.
 */
export function isChildSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isMetaFileEntry(entry: unknown): entry is MetaFileEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return record.type === 'file' && isNonEmptyString(record.name) && isOptionalNonEmptyString(record.label);
}

function isMetaDirEntry(entry: unknown): entry is MetaDirEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return (
    record.type === 'dir' &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.label) &&
    isOptionalBoolean(record.collapsible) &&
    isOptionalBoolean(record.collapsed)
  );
}

function isMetaSectionHeaderEntry(entry: unknown): entry is MetaSectionHeaderEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return record.type === 'section-header' && isNonEmptyString(record.label);
}

/** Reads and validates one `_meta.json` navigation array. */
export function readMetaEntries(directory: string): readonly MetaEntry[] {
  const path = join(directory, '_meta.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Documentation navigation is missing or invalid: ${path}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Documentation navigation is not an array: ${path}`);
  }
  const entries: MetaEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        throw new Error(`Documentation navigation contains an empty entry: ${path}`);
      }
      if (!isChildSegment(entry)) {
        throw new Error(`Documentation navigation entry must name a single child segment: ${entry} (${path})`);
      }
      entries.push(entry);
      continue;
    }
    if (isMetaFileEntry(entry)) {
      if (!isChildSegment(entry.name)) {
        throw new Error(`Documentation navigation file must name a single child segment: ${entry.name} (${path})`);
      }
      entries.push(
        entry.label === undefined
          ? { type: 'file', name: entry.name }
          : { type: 'file', name: entry.name, label: entry.label },
      );
      continue;
    }
    if (isMetaDirEntry(entry)) {
      if (!isChildSegment(entry.name)) {
        throw new Error(`Documentation navigation directory must name a single child segment: ${entry.name} (${path})`);
      }
      entries.push({
        type: 'dir',
        name: entry.name,
        label: entry.label,
        ...(entry.collapsible === undefined ? {} : { collapsible: entry.collapsible }),
        ...(entry.collapsed === undefined ? {} : { collapsed: entry.collapsed }),
      });
      continue;
    }
    if (isMetaSectionHeaderEntry(entry)) {
      entries.push({ type: 'section-header', label: entry.label });
      continue;
    }
    throw new Error(`Documentation navigation contains an unsupported entry: ${path}`);
  }
  return entries;
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function routePrefix(lang: DocsLocale): string {
  return lang === 'zh' ? '' : `/${lang}`;
}

function readNavItems(localeRoot: string, lang: DocsLocale): DocsNavItem[] {
  const path = join(localeRoot, '_nav.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Documentation top navigation is missing or invalid: ${path}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Documentation top navigation is not an array: ${path}`);
  }
  const prefix = routePrefix(lang);
  const items: DocsNavItem[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Documentation top navigation contains an invalid item: ${path}`);
    }
    const record = raw as Record<string, unknown>;
    if (!isNonEmptyString(record.text) || !isNonEmptyString(record.link)) {
      throw new Error(`Documentation top navigation item must have text and link: ${path}`);
    }
    if (!isOptionalNonEmptyString(record.activeMatch)) {
      throw new Error(`Documentation top navigation item has an invalid activeMatch: ${path}`);
    }
    if (record.position !== undefined && record.position !== 'left' && record.position !== 'right') {
      throw new Error(`Documentation top navigation item has an invalid position: ${path}`);
    }
    const link =
      isExternalUrl(record.link) || prefix === '' || record.link.startsWith(`${prefix}/`)
        ? record.link
        : `${prefix}${record.link.startsWith('/') ? record.link : `/${record.link}`}`;
    items.push({
      text: record.text,
      link,
      ...(record.activeMatch === undefined ? {} : { activeMatch: record.activeMatch }),
      ...(record.position === undefined ? {} : { position: record.position }),
    });
  }
  return items;
}

function decodeFrontmatterScalar(raw: string, label: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Documentation page has an invalid quoted frontmatter title: ${label}`);
  }
  if (typeof parsed !== 'string' || parsed.length === 0) {
    throw new Error(`Documentation page has a non-string frontmatter title: ${label}`);
  }
  return parsed;
}

function readPageTitle(text: string, label: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if ((lines[0] ?? '').trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing !== -1) {
      for (const line of lines.slice(1, closing)) {
        const separator = line.indexOf(':');
        if (separator > 0 && line.slice(0, separator).trim() === 'title') {
          const title = decodeFrontmatterScalar(line.slice(separator + 1), label);
          if (title.length > 0) {
            return title;
          }
        }
      }
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  if (h1.length > 0) {
    return h1;
  }
  throw new Error(`Documentation page is missing a title: ${label}`);
}

function pageRoute(prefix: string, relativeDir: string, name: string): string {
  const base = relativeDir === '' ? `${prefix}/docs` : `${prefix}/docs/${relativeDir}`;
  return name === 'index' ? `${base}/` : `${base}/${name}`;
}

/**
 * Loads one locale's `_nav.json` and splits `docs/_meta.json`'s top-level
 * directories (`guides`, `configuration`, `developer`) into dedicated scoped
 * sidebars so each top-nav section shows only its own pages, while `/docs`
 * keeps an overview sidebar linking to all three sections.
 */
export function loadLocaleNavigation(contentRoot: string, lang: DocsLocale): DocsLocaleNavigation {
  const localeRoot = resolve(contentRoot, lang);
  const docsDir = join(localeRoot, 'docs');
  const prefix = routePrefix(lang);
  const nav = readNavItems(localeRoot, lang);
  let generatedCache: ReadonlyMap<string, string> | undefined;

  const resolveFileItem = (relativeDir: string, name: string, label?: string): DocsSidebarItem => {
    const docRelPath = relativeDir === '' ? `${name}.md` : `${relativeDir}/${name}.md`;
    const fullPath = join(docsDir, docRelPath);
    const link = pageRoute(prefix, relativeDir, name);
    if (existsSync(fullPath)) {
      if (label !== undefined) {
        return { text: label, link };
      }
      return { text: readPageTitle(readFileSync(fullPath, 'utf8'), docRelPath), link };
    }
    // Generated pages are gitignored and only written by `scripts/docs/prepare.ts`;
    // allow reading navigation cleanly before prepare (e.g. during unit tests).
    if (isGeneratedPage(docRelPath)) {
      if (label !== undefined) {
        return { text: label, link };
      }
      generatedCache ??= renderGeneratedPages(lang);
      const generated = generatedCache.get(docRelPath);
      if (generated !== undefined) {
        return { text: readPageTitle(generated, docRelPath), link };
      }
    }
    throw new Error(`Missing documentation page listed in _meta.json: ${docRelPath}`);
  };

  const buildDirectoryItems = (relativeDir: string): DocsSidebarEntry[] => {
    const entries = readMetaEntries(join(docsDir, relativeDir));
    const items: DocsSidebarEntry[] = [];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        items.push(resolveFileItem(relativeDir, entry));
        continue;
      }
      if (entry.type === 'file') {
        items.push(resolveFileItem(relativeDir, entry.name, entry.label));
        continue;
      }
      if (entry.type === 'section-header') {
        items.push({ sectionHeaderText: entry.label });
        continue;
      }
      const childRelDir = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const group: DocsSidebarGroup = {
        text: entry.label,
        items: buildDirectoryItems(childRelDir),
        ...(entry.collapsible === undefined ? {} : { collapsible: entry.collapsible }),
        ...(entry.collapsed === undefined ? {} : { collapsed: entry.collapsed }),
      };
      items.push(group);
    }
    return items;
  };

  const rootEntries = readMetaEntries(docsDir);
  const overviewItems: DocsSidebarEntry[] = [];
  const sidebar: Record<string, DocsSidebarEntry[]> = {};
  for (const entry of rootEntries) {
    if (typeof entry === 'string') {
      overviewItems.push(resolveFileItem('', entry));
      continue;
    }
    if (entry.type === 'file') {
      overviewItems.push(resolveFileItem('', entry.name, entry.label));
      continue;
    }
    if (entry.type === 'section-header') {
      overviewItems.push({ sectionHeaderText: entry.label });
      continue;
    }
    const sectionKey = `${prefix}/docs/${entry.name}`;
    sidebar[sectionKey] = buildDirectoryItems(entry.name);
    overviewItems.push({ text: entry.label, link: `${sectionKey}/` });
  }
  sidebar[`${prefix}/docs`] = overviewItems;

  return { nav, sidebar };
}
