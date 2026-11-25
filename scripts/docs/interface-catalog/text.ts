import type { DocsLocale } from '../locales.ts';
import { textEn } from './text-en.ts';
import type { CatalogText } from './text-shape.ts';
import { textZh } from './text-zh.ts';

/** The page titles, group labels and legend of one locale; the route data is shared. */
export const CATALOG_TEXT: Record<DocsLocale, CatalogText> = { zh: textZh, en: textEn };
