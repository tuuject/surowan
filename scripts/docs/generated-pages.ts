import { FIELDS_INDEX_PAGE, isConfigFieldSectionPage, renderConfigFieldPages } from './config-fields/index.ts';
import { renderInterfaceCatalogPages } from './interface-catalog/index.ts';
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

// The field reference itself lives in `config-fields/` and the interface catalogs in
// `interface-catalog/`; this module stays the one registry for every generated page set.

/**
 * The interface catalogs: one page per Admin API route group plus the MCP tool
 * and client CLI tables. Declared by path so prepare, the Bot manual and the
 * site verifier agree on which files are generated.
 */
const INTERFACE_CATALOG_PAGE = /^developer\/(?:http\/endpoints-[a-z-]+\.md|mcp-tools\.md|cli-commands\.md)$/;

const configFieldsPageSet: GeneratedPageSet = {
  id: 'config-fields',
  matches: (path) => path === FIELDS_INDEX_PAGE || isConfigFieldSectionPage(path),
  render: renderConfigFieldPages,
};

const interfaceCatalogPageSet: GeneratedPageSet = {
  id: 'interface-catalog',
  matches: (path) => INTERFACE_CATALOG_PAGE.test(path),
  render: renderInterfaceCatalogPages,
};

export const generatedPageSets: readonly GeneratedPageSet[] = [configFieldsPageSet, interfaceCatalogPageSet];

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
