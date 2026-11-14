import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from '../locales/resources.ts';

export const LANGUAGE_KEY = 'admin-language';

export type AppLanguage = 'en' | 'zh-CN' | 'de-DE' | 'ar';

export type TextDirection = 'ltr' | 'rtl';

export const LANGUAGES: readonly AppLanguage[] = ['en', 'zh-CN', 'de-DE', 'ar'];

/** Each language named in itself, so it stays recognisable whatever the current language. */
export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  'zh-CN': '中文',
  'de-DE': 'Deutsch',
  ar: 'العربية',
};

/**
 * The one place that knows a language's writing direction. Feature code asks
 * `useDirection()`/`directionFor()` and never inspects the language itself.
 */
export const LANGUAGE_DIRECTIONS: Record<AppLanguage, TextDirection> = {
  en: 'ltr',
  'zh-CN': 'ltr',
  'de-DE': 'ltr',
  ar: 'rtl',
};

/** A stored preference, a browser language tag or `i18next.language` mapped onto a supported language. */
export function toAppLanguage(value: string | undefined): AppLanguage {
  if (value === 'en' || value === 'zh-CN' || value === 'de-DE' || value === 'ar') {
    return value;
  }
  const lower = (value ?? '').toLowerCase();
  if (lower.startsWith('zh')) {
    return 'zh-CN';
  }
  if (lower.startsWith('de')) {
    return 'de-DE';
  }
  if (lower.startsWith('ar')) {
    return 'ar';
  }
  return 'en';
}

/**
 * Stored preference wins (same pattern as the theme), then the browser
 * language, then English.
 */
export function resolveInitialLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored !== null && (LANGUAGES as readonly string[]).includes(stored)) {
      return toAppLanguage(stored);
    }
  } catch {
    // localStorage unavailable
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return toAppLanguage(navigator.language);
  }
  return 'en';
}

/** The writing direction of a language; the only direction lookup in the app. */
export function directionFor(language: AppLanguage): TextDirection {
  return LANGUAGE_DIRECTIONS[language];
}

/** The active language, as an `AppLanguage` (react-i18next hands out `i18n.language` as a plain string). */
export function currentLanguage(language: string | undefined = i18next.language): AppLanguage {
  return toAppLanguage(language);
}

/** `document.documentElement` carries both: `lang` for translation/hyphenation, `dir` for layout. */
function applyDocumentLanguage(language: AppLanguage): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.lang = language;
  root.dir = directionFor(language);
  document.title = i18next.t('brand.adminTitle');
}

void i18next.use(initReactI18next).init({
  resources,
  lng: resolveInitialLanguage(),
  fallbackLng: 'en',
  returnNull: false,
  interpolation: { escapeValue: false },
});

applyDocumentLanguage(currentLanguage());
// Covers `setLanguage` and any direct `i18next.changeLanguage` (Playground-style
// previews, tests): one listener, one place that touches the document.
i18next.on('languageChanged', () => applyDocumentLanguage(currentLanguage()));

export function setLanguage(lang: AppLanguage): void {
  void i18next.changeLanguage(lang);
  try {
    localStorage.setItem(LANGUAGE_KEY, lang);
  } catch {
    // localStorage unavailable
  }
  applyDocumentLanguage(lang);
}

export default i18next;
