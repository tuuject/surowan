import type { DictionaryConflict, DictionaryEntryRecord } from './dictionary.ts';
import { dictionaryTextMatches, normalizeDictionaryMatch } from './dictionary-match.ts';
import type { DictionaryListFilter, DictionaryStore } from './dictionary-store.ts';

/**
 * String matching over terms and aliases. Case-sensitive and literal by design:
 * no tokenization, no stemming and no semantic expansion. The only relaxation is
 * pangu spacing at a Han/ASCII boundary (`AB 钙` matches `AB钙`), applied by
 * `dictionaryTextMatches`; every other character, including the case of an ASCII
 * value and whitespace between two ASCII words, must match verbatim.
 */
export function matchingEntries(
  entries: readonly DictionaryEntryRecord[],
  texts: readonly string[],
): DictionaryEntryRecord[] {
  if (texts.length === 0) {
    return [];
  }
  return entries.filter((entry) => {
    const needles = [entry.term, ...entry.aliases].filter((value) => value.length > 0);
    return needles.some((needle) => texts.some((text) => dictionaryTextMatches(text, needle)));
  });
}

/**
 * Entries that share a term or alias with a different entry. Two values that are
 * equal after the pangu-boundary normalization (`AB 钙` and `AB钙`) are the same
 * conflicting value, so the group's `value` is the normalized key — the same
 * equivalence matching uses. The result is sorted and every group has at least
 * two distinct entry IDs. Case and ASCII-internal spacing stay significant, so
 * `AB` and `ab` — or `A B` and `AB` — are still different values.
 */
export function conflictGroups(entries: readonly DictionaryEntryRecord[]): DictionaryConflict[] {
  return conflictGroupsFromValues(entries);
}

/** The term/alias/identity shape the conflict report needs; records satisfy it. */
export interface ConflictValueEntry {
  readonly id: string;
  readonly term: string;
  readonly aliases: readonly string[];
}

/**
 * The conflict grouping core, shared by stored records and import-preview rows
 * (which carry synthetic `import:N` ids). Same normalization and ordering as
 * `conflictGroups`.
 */
export function conflictGroupsFromValues(entries: readonly ConflictValueEntry[]): DictionaryConflict[] {
  const byValue = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const value of [entry.term, ...entry.aliases]) {
      if (value.length === 0) {
        continue;
      }
      const key = normalizeDictionaryMatch(value);
      const ids = byValue.get(key) ?? new Set<string>();
      ids.add(entry.id);
      byValue.set(key, ids);
    }
  }
  return [...byValue.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([value, ids]) => ({ value, entryIds: [...ids].sort() }))
    .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
}

/** The conflicts a caller sees for one scope: the listed entries plus, for a group, the global ones. */
export function conflictsForScope(store: DictionaryStore, filter: DictionaryListFilter): DictionaryConflict[] {
  const scoped = store.list(filter);
  if (filter.scope === 'global') {
    return conflictGroups(scoped);
  }
  const globals = store.list({ scope: 'global' });
  return conflictGroups([...globals, ...scoped]);
}
