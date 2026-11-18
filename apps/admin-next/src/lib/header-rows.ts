/**
 * Pure header-row logic behind `HeaderFields`, kept out of the component so it
 * can be unit tested without the UI.
 */

import type { SecretInput } from './api/keychain.ts';
import i18n from './i18n.ts';
import { initialSecretDraft, type SecretDraft, secretValueOf } from './secret-draft.ts';

export interface HeaderRow {
  readonly name: string;
  /** The key input of this row; a stored row starts on its current reference. */
  readonly draft: SecretDraft;
  /** Saved headers cannot be renamed; renaming is delete + add. */
  readonly existing: boolean;
}

export function headerRowsFromNames(
  names: readonly string[],
  sources: Readonly<Record<string, import('./api/keychain.ts').SecretSource>> = {},
): readonly HeaderRow[] {
  return names.map((name) => ({
    name,
    // The name stays unstated so the server derives `<provider>-<header>` at
    // save time; an untouched row never pins an entry name.
    draft: {
      ...initialSecretDraft(sources[name] ?? null, name),
      ...(initialSecretDraft(sources[name] ?? null, name).mode === 'new' ? { name: '' } : {}),
    },
    existing: true,
  }));
}

/** A new row starts as a fresh key; the name is derived from the header at save time. */
export function newHeaderRow(): HeaderRow {
  return { name: '', draft: { mode: 'new', value: '', name: '' }, existing: false };
}

/** Turns the rows into the `headers` object of a write request: saved rows keep
 * their reference when the draft stays on it, new rows must carry both a name
 * and a value, and rows the admin removed become `null` (delete).
 */
export function headerPayload(
  rows: readonly HeaderRow[],
  removedNames: readonly string[],
  nameBase: string,
): {
  readonly headers: Readonly<Record<string, SecretInput | null>> | undefined;
  readonly error: string | null;
} {
  const headers: Record<string, SecretInput | null> = {};
  // Deletions first, so a row that re-adds a removed name keeps its new value.
  for (const name of removedNames) {
    headers[name] = null;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) {
      if (!row.existing) {
        return { headers: undefined, error: i18n.t('models.models.headers.needsName') };
      }
      continue;
    }
    if (seen.has(name)) {
      return { headers: undefined, error: i18n.t('models.models.headers.listedTwice', { name }) };
    }
    seen.add(name);
    const value = secretValueOf(row.draft, `${nameBase}-${name}`);
    if (value === null) {
      if (!row.existing) {
        return { headers: undefined, error: i18n.t('models.models.headers.needsValue', { name }) };
      }
      continue;
    }
    headers[name] = value;
  }
  return { headers: Object.keys(headers).length === 0 ? undefined : headers, error: null };
}

/** The same rows for a request that only sends values (discovery, new provider). */
export function headerValues(
  rows: readonly HeaderRow[],
  nameBase: string,
): {
  readonly values: Readonly<Record<string, SecretInput>> | undefined;
  readonly error: string | null;
} {
  const payload = headerPayload(rows, [], nameBase);
  if (payload.error !== null || payload.headers === undefined) {
    return { values: undefined, error: payload.error };
  }
  const values: Record<string, SecretInput> = {};
  for (const [name, value] of Object.entries(payload.headers)) {
    if (value !== null) {
      values[name] = value;
    }
  }
  return { values: Object.keys(values).length === 0 ? undefined : values, error: null };
}

/**
 * Saved header names that are no longer in the edited rows. A name that a new
 * row adds back is a replacement, not a deletion.
 */
export function removedHeaderNames(original: readonly string[], rows: readonly HeaderRow[]): readonly string[] {
  const kept = new Set(rows.map((row) => (row.existing ? row.name : row.name.trim())));
  return original.filter((name) => !kept.has(name));
}
