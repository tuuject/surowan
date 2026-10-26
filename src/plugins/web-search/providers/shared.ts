import type { RawSearchHit } from '../extension.ts';

/**
 * Response reading shared by the provider plugins. Providers disagree on field
 * names far more than on shapes, so each plugin names the paths it accepts and
 * this module does the tolerant walking.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The first non-empty array found at a dotted path, e.g. `data.web`. */
export function firstArray(payload: unknown, paths: readonly string[]): readonly unknown[] | undefined {
  for (const path of paths) {
    let current: unknown = payload;
    for (const segment of path.split('.')) {
      const record = asRecord(current);
      if (record === undefined) {
        current = undefined;
        break;
      }
      current = record[segment];
    }
    const array = asArray(current);
    if (array !== undefined && array.length > 0) {
      return array;
    }
  }
  return undefined;
}

/** Reads the first string field present, in the order given. */
export function readAnyString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** One hit from a provider entry; entries without a URL are dropped later. */
export function toHit(entry: unknown, snippetKeys: readonly string[]): RawSearchHit | undefined {
  const record = asRecord(entry);
  if (record === undefined) {
    return undefined;
  }
  const title = readAnyString(record, ['title', 'name']);
  const url = readAnyString(record, ['url', 'link']);
  const snippet = readAnyString(record, snippetKeys);
  return {
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

export function mapHits(entries: readonly unknown[], snippetKeys: readonly string[]): RawSearchHit[] {
  return entries.flatMap((entry) => {
    const hit = toHit(entry, snippetKeys);
    return hit === undefined ? [] : [hit];
  });
}
