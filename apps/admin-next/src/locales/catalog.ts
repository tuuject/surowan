/**
 * Catalog contract for the non-English translations. English (`src/locales/en/**`)
 * is the source: a translation must carry every key with the same nesting and
 * the same leaf type, so key drift or a typo in a nested object fails `tsc`
 * instead of silently falling back to English at runtime.
 *
 * Count-driven keys are the one place where a translation legitimately adds
 * keys English doesn't have: i18next addresses them as `<base>_<CLDR
 * category>`, and the set of categories is a property of the target language.
 * English splits some of them (`_one`/`_other`) and leaves others unsuffixed
 * (`'{{count}} model call(s)'`); Arabic needs six forms for both, so
 * `Catalog<T>` accepts the six variant keys of *any* string key and
 * `CompleteCatalog<T>` requires them for every English `_one`/`_other` base.
 * The unsuffixed count bases are verified by `catalog.test.ts`, which derives
 * them from the English text containing `{{count}}`.
 */

/** The suffixes i18next looks up for a `count` (`zero`…`other` are the CLDR categories). */
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** `cursorPageCount_one` → `cursorPageCount`; a key without a plural suffix → `never`. */
type PluralBaseOf<K extends string> = K extends `${infer Base}_one`
  ? Base
  : K extends `${infer Base}_other`
    ? Base
    : never;

/** Every key of `T` that looks like an English plural base. */
type PluralBases<T> = { [K in keyof T & string]: PluralBaseOf<K> }[keyof T & string];

/** `${key}_zero` … `${key}_other` for every string leaf: allowed everywhere, required for English plural bases. */
type OptionalVariants<T> = {
  readonly [K in keyof T & string as T[K] extends string ? `${K}_${PluralCategory}` : never]?: string;
};

type RequiredVariants<T> = {
  readonly [Base in PluralBases<T> as `${Base}_${PluralCategory}`]: string;
};

type Shape<T, Mode extends PluralMode> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends object ? Shape<T[K], Mode> : T[K];
} & OptionalVariants<T> &
  // `required` wins over the optional variants of the same keys.
  (Mode extends 'required' ? RequiredVariants<T> : unknown);

type PluralMode = 'optional' | 'required';

/**
 * Every English key, same nesting, same leaf types, plus optional CLDR variants
 * (`<key>_zero` … `<key>_other`) of any string key.
 */
export type Catalog<T> = Shape<T, 'optional'>;

/**
 * As `Catalog`, but every English `_one`/`_other` plural base must provide all
 * six CLDR categories — Arabic uses `zero`, `two`, `few` and `many` on top of
 * `one`/`other`.
 */
export type CompleteCatalog<T> = Shape<T, 'required'>;
