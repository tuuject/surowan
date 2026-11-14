import type { Catalog } from '../../catalog.ts';
import type { preferences as preferencesEn } from '../../en/pages/preferences.ts';

/** Mirrors `en/pages/preferences.ts` key for key. */
export const preferences: Catalog<typeof preferencesEn> = {
  themeLabel: 'Design',
  languageLabel: 'Sprache',
  displayTitle: 'Darstellung',
};
