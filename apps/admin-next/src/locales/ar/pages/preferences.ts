import type { CompleteCatalog } from '../../catalog.ts';
import type { preferences as preferencesEn } from '../../en/pages/preferences.ts';

/** Mirrors `en/pages/preferences.ts` key for key. */
export const preferences: CompleteCatalog<typeof preferencesEn> = {
  themeLabel: 'المظهر',
  languageLabel: 'اللغة',
  displayTitle: 'العرض',
};
