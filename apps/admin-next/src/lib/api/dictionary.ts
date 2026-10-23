import { ApiError, call, postJson, writeHeaders } from './core.ts';

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------
/**
 * A dictionary entry. `id` and `chat_id` are opaque strings (bigint Telegram
 * IDs travel as strings); `revision` is the entry's own optimistic-lock token,
 * echoed back via `If-Match` on write and delete.
 */
export interface DictionaryEntry {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
  readonly scope: DictionaryScope;
  readonly chat_id: string | null;
  readonly enabled: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: string;
}

export type DictionaryScope = 'global' | 'group';

/** The draft shape shared by create, update, import and merge. */
export interface DictionaryDraft {
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
  readonly scope: DictionaryScope;
  readonly chat_id: string | null;
  readonly enabled: boolean;
}

/** Two entries that carry the exact same string in a Term or an Alias. */
export interface DictionaryConflict {
  readonly value: string;
  readonly entry_ids: readonly string[];
}

export interface DictionaryView {
  readonly items: readonly DictionaryEntry[];
  readonly conflicts: readonly DictionaryConflict[];
}

export interface DictionaryImportPreview {
  readonly entries: readonly DictionaryDraft[];
  readonly conflicts: readonly DictionaryConflict[];
}

export interface DictionaryChatOption {
  /** Telegram chat ID, kept as a string end to end. */
  readonly id: string;
  readonly title: string | null;
  readonly type: string;
}

export const DICTIONARY_INJECTION_MODES = ['off', 'on_demand', 'aggressive'] as const;

export type DictionaryInjectionMode = (typeof DICTIONARY_INJECTION_MODES)[number];

export interface DictionarySettings {
  readonly revision: string;
  /** The global mode; group scope may override it. */
  readonly injection_mode: DictionaryInjectionMode;
  /** Group scope only: the per-chat override, or null when it inherits. */
  readonly override_mode: DictionaryInjectionMode | null;
  /** The mode actually in force for the queried scope. */
  readonly effective_mode: DictionaryInjectionMode;
}

export interface DictionaryMergeSuggestion {
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
}

export interface DictionaryMergePreview {
  readonly suggestion: DictionaryMergeSuggestion;
  readonly sources: readonly DictionaryEntry[];
}

export interface DictionaryMergeSourceRef {
  readonly id: string;
  readonly revision: string;
}

export function listDictionary(query: {
  readonly scope: DictionaryScope;
  readonly chat?: string | null;
  readonly search?: string;
}): Promise<DictionaryView> {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.chat !== null && query.chat !== undefined && query.chat.length > 0) {
    params.set('chat', query.chat);
  }
  if (query.search !== undefined && query.search.length > 0) {
    params.set('search', query.search);
  }
  return call<DictionaryView>(`/dictionary?${params.toString()}`);
}

export function listDictionaryChats(): Promise<{ readonly items: readonly DictionaryChatOption[] }> {
  return call<{ readonly items: readonly DictionaryChatOption[] }>('/dictionary/chats');
}

export function createDictionaryEntry(draft: DictionaryDraft): Promise<DictionaryEntry> {
  return postJson<DictionaryEntry>('/dictionary', draft);
}

export function updateDictionaryEntry(id: string, draft: DictionaryDraft, revision: string): Promise<DictionaryEntry> {
  return call<DictionaryEntry>(`/dictionary/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(draft),
  });
}

export function deleteDictionaryEntry(id: string, revision: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/dictionary/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export function getDictionarySettings(chat?: string | null): Promise<DictionarySettings> {
  const params = new URLSearchParams();
  if (chat !== null && chat !== undefined && chat.length > 0) {
    params.set('chat', chat);
  }
  const query = params.toString();
  return call<DictionarySettings>(query.length === 0 ? '/dictionary/settings' : `/dictionary/settings?${query}`);
}

export function putDictionarySettings(
  injectionMode: DictionaryInjectionMode | null,
  revision: string,
  chat?: string | null,
): Promise<DictionarySettings> {
  const params = new URLSearchParams();
  if (chat !== null && chat !== undefined && chat.length > 0) {
    params.set('chat', chat);
  }
  const query = params.toString();
  return call<DictionarySettings>(query.length === 0 ? '/dictionary/settings' : `/dictionary/settings?${query}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ injection_mode: injectionMode }),
  });
}

export function previewDictionaryImport(body: {
  readonly format: DictionaryExportFormat;
  readonly content: string;
  readonly scope: DictionaryScope;
  readonly chat_id: string | null;
}): Promise<DictionaryImportPreview> {
  return postJson<DictionaryImportPreview>('/dictionary/import/preview', body);
}

export function importDictionaryEntries(entries: readonly DictionaryDraft[]): Promise<{
  readonly items: readonly DictionaryEntry[];
}> {
  return postJson<{ readonly items: readonly DictionaryEntry[] }>('/dictionary/import', { entries });
}

export type DictionaryExportFormat = 'csv' | 'jsonl';

/** The export endpoint answers a file body, not JSON; read it as text. */
export async function fetchDictionaryExport(query: {
  readonly scope: DictionaryScope;
  readonly chat?: string | null;
  readonly format: DictionaryExportFormat;
}): Promise<{ readonly filename: string; readonly text: string }> {
  const params = new URLSearchParams({ scope: query.scope, format: query.format });
  if (query.chat !== null && query.chat !== undefined && query.chat.length > 0) {
    params.set('chat', query.chat);
  }
  const suffix = query.scope === 'group' && query.chat !== null ? `-${query.chat}` : '';
  const filename = `dictionary-${query.scope}${suffix}.${query.format}`;
  const response = await fetch(`/api/dictionary/export?${params.toString()}`, { credentials: 'same-origin' });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const body = payload as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message ?? `Admin API request failed with status ${response.status}`,
      payload,
    );
  }
  return { filename, text };
}

export function previewDictionaryMerge(ids: readonly string[]): Promise<DictionaryMergePreview> {
  return postJson<DictionaryMergePreview>('/dictionary/merge/preview', { ids });
}

export function mergeDictionaryEntries(body: {
  readonly entry: DictionaryDraft;
  readonly sources: readonly DictionaryMergeSourceRef[];
  readonly delete_sources: boolean;
}): Promise<{ readonly entry: DictionaryEntry }> {
  return postJson<{ readonly entry: DictionaryEntry }>('/dictionary/merge', body);
}
