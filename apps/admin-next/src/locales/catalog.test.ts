import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import i18next from '../lib/i18n.ts';
import { ar, deDE, en, zhCN } from './resources.ts';

/**
 * Catalog integrity. English is the source; `tsc` already rejects a missing or
 * extra key (the `Catalog`/`CompleteCatalog` annotations), so what remains is
 * what types cannot see:
 *
 * - an interpolated `{{variable}}` that a translation dropped or renamed
 *   (the sentence would render with a literal placeholder, or silently lose
 *   the value),
 * - a plural base that a language needs but doesn't provide — Arabic uses all
 *   six CLDR categories, so `_other` alone renders "3 records" as "1 record",
 * - and i18next actually picking a translated form instead of falling back to
 *   the raw key when a `count` is passed.
 */

type Catalog = { readonly [key: string]: unknown };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
// `{{name}}` or `{{name, number}}`; the formatter stays out of the placeholder name.
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,\s*[\w]+\s*)?\}\}/g;
const TAGGED = /<[a-zA-Z][^>]*>/;
const COUNTS = [0, 1, 2, 3, 11, 100] as const;

/** `a.b.c` → leaf string, for every string leaf of a catalog tree. */
function leaves(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') {
    out.set(prefix, value);
    return out;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Unexpected catalog leaf at ${prefix}: ${typeof value}`);
  }
  for (const [key, child] of Object.entries(value)) {
    leaves(child, prefix.length === 0 ? key : `${prefix}.${key}`, out);
  }
  return out;
}

function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''));
}

interface Family {
  readonly variants: ReadonlyMap<string, string>;
  readonly placeholders: ReadonlySet<string>;
}

/** Groups a flat catalog by plural base: `a.totalCount_one` and `a.totalCount_other` share one family. */
function families(catalog: Catalog): Map<string, Family> {
  const grouped = new Map<string, Map<string, string>>();
  for (const [path, text] of leaves(catalog)) {
    const base = path.replace(PLURAL_SUFFIX, '');
    const variants = grouped.get(base) ?? new Map<string, string>();
    variants.set(path, text);
    grouped.set(base, variants);
  }
  const result = new Map<string, Family>();
  for (const [base, variants] of grouped) {
    const all = new Set<string>();
    for (const text of variants.values()) {
      for (const name of placeholders(text)) {
        all.add(name);
      }
    }
    result.set(base, { variants, placeholders: all });
  }
  return result;
}

const LOCALES: ReadonlyArray<{ readonly language: string; readonly catalog: Catalog }> = [
  { language: 'zh-CN', catalog: zhCN },
  { language: 'de-DE', catalog: deDE },
  { language: 'ar', catalog: ar },
];

const ARABIC_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

const enFamilies = families(en as Catalog);
const enPluralBases = [...enFamilies].filter(([, family]) =>
  [...family.variants.keys()].some((path) => PLURAL_SUFFIX.test(path)),
);

/**
 * Keys English leaves unsuffixed but passes a numeric `count` (`'{{count}} model
 * call(s)'`). English renders the one string for every count; Arabic needs the
 * six CLDR forms, so these bases are checked exactly like the `_one`/`_other`
 * families.
 */
const enCountBases = [...enFamilies].filter(
  ([, family]) =>
    ![...family.variants.keys()].some((path) => PLURAL_SUFFIX.test(path)) &&
    [...family.variants.values()].some((text) => /\{\{\s*count\s*\}\}/.test(text)),
);

/**
 * Bases whose caller picks between two keys by hand instead of passing a count
 * to i18next (`count === 1 ? oneModel : manyModels`). Arabic phrases these as a
 * label plus the number ("النماذج: {{count}}"), which is correct for 0, 1, 2, 3,
 * 11 and 100 alike, so they need no CLDR variants; the render test below still
 * checks that the neutral string is what comes out for every count.
 */
const MANUAL_PAIR_KEYS = new Set([
  'models.models.page.oneModel',
  'models.models.page.manyModels',
  'models.models.restart.onePending',
  'models.models.restart.manyPending',
  'models.models.picker.addOne',
  'models.models.picker.addMany',
]);

/**
 * Source scans. Both catch mistakes the catalogs cannot: a key that uses markup
 * but is rendered through `t()` (the tags show up as literal text), and a
 * `count` that is a string (i18next then never resolves a plural form).
 */
const SRC = join(import.meta.dirname, '..');

function sourceFiles(directory: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Catalogs are the other side of these checks.
      if (entry.name !== 'locales') {
        sourceFiles(path, out);
      }
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const SOURCES = sourceFiles().map((path) => ({ path: path.slice(SRC.length + 1), text: readFileSync(path, 'utf8') }));

/** Tagged keys are rendered through `Trans`; `t()` would print the tag literally. */
test('a key with markup is never rendered through t()', () => {
  const tagged = new Set<string>();
  for (const catalog of [en, zhCN, deDE, ar] as Catalog[]) {
    for (const [base, family] of families(catalog)) {
      if ([...family.variants.values()].some((text) => TAGGED.test(text))) {
        tagged.add(base);
      }
    }
  }
  expect(tagged.size).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const { path, text } of SOURCES) {
    for (const key of tagged) {
      const call = new RegExp(`\\bt\\(\\s*['"\`]${key.replaceAll('.', '\\.')}['"\`]`);
      if (call.test(text)) {
        problems.push(`${path}: t('${key}') on a key with markup; render it with <Trans>`);
      }
    }
  }
  expect(problems).toEqual([]);
});

/** i18next only pluralizes when `count` is a number. */
test('every count: value is a number, not a formatted string', () => {
  const forbidden = /\bcount:\s*(?:[\s\n]*)(formatNumber\(|String\(|`)/;
  const problems: string[] = [];
  for (const { path, text } of SOURCES) {
    for (const [index, line] of text.split('\n').entries()) {
      if (forbidden.test(line)) {
        problems.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  expect(problems).toEqual([]);
});

const TAG = /<(\/?[a-zA-Z]+)>/g;

function tags(text: string): Set<string> {
  return new Set([...text.matchAll(TAG)].map((match) => match[1] ?? ''));
}

/**
 * Fills every `{{name}}` of a catalog string. `{{name, number}}` formats the value
 * the way i18next does, so an expected string can be compared literally.
 */
function fill(text: string, values: Readonly<Record<string, string | number>>, language: string): string {
  return text.replace(
    /\{\{\s*([\w.]+)\s*(?:,\s*([\w]+)\s*)?\}\}/g,
    (_match, name: string, format: string | undefined) => {
      const value = values[name] ?? `#${name}#`;
      return format === 'number' ? new Intl.NumberFormat(language).format(Number(value)) : String(value);
    },
  );
}

/** Marker values for every placeholder of a family; `count` is the real one. */
function valuesFor(family: Family, count: number): Record<string, string | number> {
  const values: Record<string, string | number> = { count };
  for (const name of family.placeholders) {
    if (name !== 'count') {
      values[name] = `#${name}#`;
    }
  }
  return values;
}

describe('catalog integrity', () => {
  test.each(LOCALES)('$language carries exactly the English keys', ({ catalog }) => {
    const translated = new Set(families(catalog).keys());
    const missing = [...enFamilies.keys()].filter((base) => !translated.has(base));
    const extra = [...translated].filter((base) => !enFamilies.has(base));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  test.each(LOCALES)('$language keeps every interpolation variable', ({ catalog }) => {
    const translated = families(catalog);
    const problems: string[] = [];
    for (const [base, source] of enFamilies) {
      const target = translated.get(base);
      if (target === undefined) {
        continue;
      }
      for (const name of source.placeholders) {
        if (!target.placeholders.has(name)) {
          problems.push(`${base}: missing {{${name}}}`);
        }
      }
      for (const name of target.placeholders) {
        if (!source.placeholders.has(name)) {
          problems.push(`${base}: unexpected {{${name}}}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test.each(LOCALES)('$language keeps every markup tag of a translated sentence', ({ catalog }) => {
    const translated = families(catalog);
    const problems: string[] = [];
    for (const [base, source] of enFamilies) {
      const target = translated.get(base);
      if (target === undefined) {
        continue;
      }
      const sourceTags = new Set([...source.variants.values()].flatMap((text) => [...tags(text)]));
      const targetTags = new Set([...target.variants.values()].flatMap((text) => [...tags(text)]));
      for (const tag of sourceTags) {
        if (!targetTags.has(tag)) {
          problems.push(`${base}: missing <${tag}>`);
        }
      }
      for (const tag of targetTags) {
        if (!sourceTags.has(tag)) {
          problems.push(`${base}: unexpected <${tag}>`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('Arabic provides all six CLDR categories for every plural and count base', () => {
    const arabic = families(ar as Catalog);
    const problems: string[] = [];
    for (const [base] of [...enPluralBases, ...enCountBases]) {
      if (MANUAL_PAIR_KEYS.has(base)) {
        continue;
      }
      const variants = arabic.get(base)?.variants.keys() ?? [];
      const categories = new Set([...variants].map((path) => path.slice(base.length + 1)));
      for (const category of ARABIC_CATEGORIES) {
        if (!categories.has(category)) {
          problems.push(`${base}: missing _${category}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test.each(LOCALES)(
    '$language renders the form its plural rules ask for, for every plural and count key',
    async ({ language, catalog }) => {
      await i18next.changeLanguage(language);
      const translated = families(catalog);
      const rules = new Intl.PluralRules(language);
      const problems: string[] = [];
      for (const [base] of [...enPluralBases, ...enCountBases]) {
        const family = translated.get(base);
        if (family === undefined) {
          continue;
        }
        for (const count of COUNTS) {
          const rendered = i18next.t(base as 'layout.business.totalCount', valuesFor(family, count));
          if (rendered === base || rendered.length === 0) {
            problems.push(`${base} @${count}: fell back to the key`);
            continue;
          }
          // i18next picks `_<category>` from Intl.PluralRules; a locale without
          // that variant renders its base string, which is correct for it.
          const category = rules.select(count);
          const text = family.variants.get(`${base}_${category}`) ?? family.variants.get(base);
          if (text === undefined) {
            problems.push(`${base} @${count}: no form for category ${category}`);
            continue;
          }
          const expected = fill(text, valuesFor(family, count), language);
          if (rendered !== expected) {
            problems.push(`${base} @${count}: got "${rendered}", expected "${expected}"`);
          }
        }
      }
      expect(problems).toEqual([]);
      await i18next.changeLanguage('en');
    },
  );
});
