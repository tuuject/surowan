import type { preferences as preferencesEn } from '../../en/pages/preferences.ts';

/** Mirrors `en/pages/preferences.ts` key for key; the annotation fails the build on drift. */
export const preferences: typeof preferencesEn = {
  themeLabel: '主题',
  languageLabel: '语言',
  displayTitle: '显示',
};
