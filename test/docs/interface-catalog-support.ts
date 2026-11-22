import { HTTP_CATALOG_PATHS, renderInterfaceCatalogPages } from '../../scripts/docs/interface-catalog/index.ts';
import { docsLocales } from '../../scripts/docs/locales.ts';

/** Fixtures shared by the catalog suites: the rendered pages and row accessors. */

/** Every catalog page of both locales, rendered once per suite file. */
export const pagesByLocale = new Map(docsLocales.map((lang) => [lang, renderInterfaceCatalogPages(lang)]));

export const EN_PAGES = pagesByLocale.get('en') ?? new Map<string, string>();

/** The rendered rows of one page: a body row starts with a method cell. */
export function tableRows(page: string): readonly string[] {
  return page.split('\n').filter((line) => /^\| (?:GET|POST|PUT|DELETE) \|/.test(line));
}

/** The route cell of a rendered row: the second `| … |` field. */
export function rowPath(row: string): string {
  const cells = row.split(' | ');
  return (cells[1] ?? '').replaceAll('`', '').trim();
}

/** The body cell of a rendered row: the fourth `| … |` field. */
export function bodyOf(row: string | undefined): string {
  return (row ?? '').split(' | ')[3] ?? '';
}

/** The first row of `page` whose text starts with `start`. */
export function findRow(page: string, start: string): string | undefined {
  return tableRows(page).find((row) => row.startsWith(start));
}

export { HTTP_CATALOG_PATHS };
