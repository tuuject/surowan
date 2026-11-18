import type { SecretInput, SecretSource } from './api/keychain.ts';

/**
 * Draft state of one secret field, shared by every secret-accepting form.
 * The pure half lives in `lib` so the forms and header-row helpers (unit
 * tested without React) agree on one conversion to the request body.
 */
export type SecretDraft =
  | { readonly mode: 'new'; readonly value: string; readonly name: string }
  | { readonly mode: 'entry'; readonly entry: string }
  | { readonly mode: 'external' };

/** The draft a field starts from, given where its secret currently comes from. */
export function initialSecretDraft(source: SecretSource, suggestedName: string): SecretDraft {
  if (source?.kind === 'env' || source?.kind === 'command') {
    return { mode: 'external' };
  }
  return { mode: 'new', value: '', name: suggestedName };
}

/** What a save sends for this draft: `null` leaves the stored reference alone. */
export function secretValueOf(draft: SecretDraft, suggestedName: string): SecretInput | null {
  if (draft.mode === 'entry') {
    return draft.entry.length === 0 ? null : { entry: draft.entry };
  }
  if (draft.mode !== 'new' || draft.value.length === 0) {
    return null;
  }
  // An unstated name (the field was never touched) lets the server derive the
  // entry name from where the field sits at save time, and rotate an entry
  // this field uses alone in place.
  return draft.name.length === 0 || draft.name === suggestedName
    ? draft.value
    : { value: draft.value, name: draft.name };
}

/** True when the draft holds an entry name the keychain naming rule rejects. */
export function secretNameInvalid(draft: SecretDraft): boolean {
  return draft.mode === 'new' && draft.name.length > 0 && !/^[A-Za-z0-9_-]{1,64}$/.test(draft.name);
}
