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

function arrayAt(payload: unknown, path: string): readonly unknown[] | undefined {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    const record = asRecord(current);
    if (record === undefined) {
      return undefined;
    }
    current = record[segment];
  }
  return asArray(current);
}

/**
 * The result list at the first dotted path (e.g. `data.web`) holding a
 * non-empty array. An empty array at any path is a genuine "no results"; so
 * is a payload the provider's `emptyEnvelope` recognises when it omits the
 * list on an empty answer. Anything else does not look like this provider's
 * answer and throws, which the core reports as `invalid_response` instead of
 * a successful empty search.
 */
export function resultList(
  payload: unknown,
  paths: readonly string[],
  emptyEnvelope?: (record: Record<string, unknown>) => boolean,
): readonly unknown[] {
  const arrays = paths.map((path) => arrayAt(payload, path));
  const found = arrays.find((array) => array !== undefined && array.length > 0);
  if (found !== undefined) {
    return found;
  }
  if (arrays.some((array) => array !== undefined)) {
    return [];
  }
  const record = asRecord(payload);
  if (record !== undefined && emptyEnvelope?.(record) === true) {
    return [];
  }
  throw new Error(`No result list at ${paths.join(', ')}`);
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
