import type { CatalogGroupId, CatalogPageId } from './pages.ts';

/** The localized prose of the generated catalogs: headings, labels and legend. */
export interface CatalogText {
  readonly column: {
    readonly method: string;
    readonly path: string;
    readonly query: string;
    readonly body: string;
    readonly access: string;
    readonly revision: string;
    readonly confirm: string;
    readonly response: string;
    readonly summary: string;
    readonly tool: string;
    readonly command: string;
  };
  readonly none: string;
  readonly accessValues: {
    readonly session: string;
    readonly public: string;
    /** Appended to the grant of a route only the programmatic dispatch serves. */
    readonly programmaticOnly: string;
  };
  readonly handWrittenLabel: Record<CatalogPageId, string>;
  readonly seeAlso: (label: string, file: string) => string;
  readonly legend: readonly string[];
  readonly pages: Record<
    CatalogPageId,
    { readonly title: string; readonly description: string; readonly intro: string }
  >;
  /** One label per group id, in both locales: a missing label is a type error. */
  readonly groups: Record<CatalogGroupId, string>;
  readonly mcp: { readonly title: string; readonly description: string; readonly intro: readonly string[] };
  readonly cli: { readonly title: string; readonly description: string; readonly intro: readonly string[] };
  readonly sourceSummary: string;
  readonly excludedRoutes: (count: number) => string;
}
