import { errorMessage } from './errors.ts';
import i18n from './i18n.ts';
import { ApiError } from './api/core.ts';
import type { DictionaryDraft, DictionaryEntry, DictionaryInjectionMode } from './api/dictionary.ts';

/**
 * Pure helpers for the Dictionary page: alias-list editing, draft conversion,
 * conflict indexing and download plumbing. Everything that can be decided
 * without a DOM lives here so it is testable on its own; the page keeps only
 * React state and mutations.
 *
 * CSV/JSONL parsing deliberately stays server-side: the preview endpoint owns
 * the grammar (`|`-separated aliases, `\|` for a literal pipe, `\\` for a
 * backslash), so the upload UI never grows a second, drifting implementation.
 */

/**
 * Splits the alias textarea into aliases: one per line, trimmed and
 * deduplicated. Only a newline separates aliases — a comma or a `|` stays a
 * literal part of its alias (unlike the CSV import grammar, which still
 * splits on `|` server-side).
 */
export function parseAliasLines(text: string): readonly string[] {
  return normalizeAliases(text.split(/\r?\n/));
}

/**
 * Renders aliases back into the textarea's one-per-line form. Pairing it with
 * `parseAliasLines` is what keeps the caret and any blank line the user is
 * still typing intact: the textarea owns its raw text and only adopts an
 * external alias list when that list stops being the echo of its own parse.
 */
export function formatAliasLines(aliases: readonly string[]): string {
  return aliases.join('\n');
}

/** Whether two alias lists are the same values in the same order. */
export function aliasesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Drops empty and duplicate aliases, keeping the first spelling. */
export function normalizeAliases(aliases: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeDraft(draft: DictionaryDraft): DictionaryDraft {
  return {
    term: draft.term.trim(),
    definition: draft.definition.trim(),
    aliases: normalizeAliases(draft.aliases),
    scope: draft.scope,
    chat_id: draft.scope === 'global' ? null : draft.chat_id,
    enabled: draft.enabled,
  };
}

export function draftFromEntry(entry: DictionaryEntry): DictionaryDraft {
  return {
    term: entry.term,
    definition: entry.definition,
    aliases: entry.aliases,
    scope: entry.scope,
    chat_id: entry.chat_id,
    enabled: entry.enabled,
  };
}

export interface DictionaryDraftErrors {
  term?: string;
  definition?: string;
  chat_id?: string;
}

/** Term and definition are required; a group entry must name its Chat. */
export function validateDraft(draft: DictionaryDraft): DictionaryDraftErrors {
  const errors: DictionaryDraftErrors = {};
  if (draft.term.trim().length === 0) {
    errors.term = i18n.t('dictionary.entry.termRequired');
  }
  if (draft.definition.trim().length === 0) {
    errors.definition = i18n.t('dictionary.entry.definitionRequired');
  }
  if (draft.scope === 'group' && (draft.chat_id === null || draft.chat_id.length === 0)) {
    errors.chat_id = i18n.t('dictionary.entry.chatRequired');
  }
  return errors;
}

/**
 * Which entries are involved in a conflict, and the values they share. The
 * API reports conflict groups; the page needs the per-entry lookup to mark
 * rows and to preselect the entries of one conflict group for a merge.
 */
export function conflictedEntryIds(
  conflicts: readonly { readonly entry_ids: readonly string[] }[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    for (const id of conflict.entry_ids) {
      ids.add(id);
    }
  }
  return ids;
}

export const DICTIONARY_CONFLICT_CODE = 'dictionary_conflict';
const REVISION_REQUIRED_CODE = 'revision_required';

/** A write refused because the entry (or its settings) moved on. */
export function isDictionaryConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === DICTIONARY_CONFLICT_CODE;
}

export function dictionaryErrorMessage(error: unknown): string {
  if (isDictionaryConflict(error)) {
    return i18n.t('dictionary.entry.staleDescription');
  }
  if (error instanceof ApiError && error.code === REVISION_REQUIRED_CODE) {
    return i18n.t('models.models.feedback.writeConflict');
  }
  return errorMessage(error);
}

export function injectionModeLabel(mode: DictionaryInjectionMode): string {
  return mode === 'off'
    ? i18n.t('dictionary.injection.modeOff')
    : mode === 'on_demand'
      ? i18n.t('dictionary.injection.modeOnDemand')
      : i18n.t('dictionary.injection.modeAggressive');
}

export function injectionModeHint(mode: DictionaryInjectionMode): string {
  return mode === 'off'
    ? i18n.t('dictionary.injection.modeOffHint')
    : mode === 'on_demand'
      ? i18n.t('dictionary.injection.modeOnDemandHint')
      : i18n.t('dictionary.injection.modeAggressiveHint');
}

/** Triggers a client-side download of text the API already returned. */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task so the click has already been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
