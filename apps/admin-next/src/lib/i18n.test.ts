import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { directionFor, LANGUAGE_KEY, resolveInitialLanguage } from './i18n.ts';

/**
 * Initial language detection. The Playwright suite pins `en-US`, so a Chinese
 * browser or a blocked storage never reaches it; only these cases do.
 */

function setBrowserLanguage(language: string): void {
  Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: language });
}

/** Minimal localStorage stand-in; `vi.unstubAllGlobals()` restores the real globals. */
function stubStorage(entries: Record<string, string> = {}): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries[key] ?? null,
    setItem: vi.fn(),
  });
}

beforeEach(() => {
  setBrowserLanguage('en-US');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBrowserLanguage('en-US');
});

describe('resolveInitialLanguage', () => {
  test('a stored preference wins over the browser language', () => {
    stubStorage({ [LANGUAGE_KEY]: 'zh-CN' });
    expect(resolveInitialLanguage()).toBe('zh-CN');

    setBrowserLanguage('zh-CN');
    stubStorage({ [LANGUAGE_KEY]: 'en' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  test('a stored German or Arabic preference wins and keeps its own tag', () => {
    stubStorage({ [LANGUAGE_KEY]: 'de-DE' });
    expect(resolveInitialLanguage()).toBe('de-DE');

    stubStorage({ [LANGUAGE_KEY]: 'ar' });
    expect(resolveInitialLanguage()).toBe('ar');

    setBrowserLanguage('en-US');
    expect(resolveInitialLanguage()).toBe('ar');
  });

  test('a German or Arabic browser language selects that language', () => {
    stubStorage();

    setBrowserLanguage('de-DE');
    expect(resolveInitialLanguage()).toBe('de-DE');
    setBrowserLanguage('de-AT');
    expect(resolveInitialLanguage()).toBe('de-DE');

    setBrowserLanguage('ar-EG');
    expect(resolveInitialLanguage()).toBe('ar');
    setBrowserLanguage('ar');
    expect(resolveInitialLanguage()).toBe('ar');
  });

  test('only Arabic reads right to left', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('zh-CN')).toBe('ltr');
    expect(directionFor('de-DE')).toBe('ltr');
  });

  test('a Chinese browser language selects zh-CN', () => {
    stubStorage();
    setBrowserLanguage('zh-CN');
    expect(resolveInitialLanguage()).toBe('zh-CN');

    setBrowserLanguage('zh-TW');
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });

  test('any other browser language falls back to English', () => {
    stubStorage();
    setBrowserLanguage('en-US');
    expect(resolveInitialLanguage()).toBe('en');

    setBrowserLanguage('fr-FR');
    expect(resolveInitialLanguage()).toBe('en');
  });

  test('an unrecognized stored value is ignored', () => {
    setBrowserLanguage('zh-CN');
    stubStorage({ [LANGUAGE_KEY]: 'de-AT' });
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });

  test('unavailable storage falls through to the browser language', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    });

    expect(resolveInitialLanguage()).toBe('en');

    setBrowserLanguage('zh-CN');
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });
});
