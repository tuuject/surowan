import { call, type ListFilters, listPath, type Page } from './core.ts';

/** The Chat a memo belongs to; the Memo Pad is Chat-scoped and shared by Topics. */
export interface MemoryChat {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
}

export interface MemoryEntry {
  readonly id: string;
  readonly chat: MemoryChat;
  readonly summary: string;
  readonly detail: string;
  readonly created_at: string;
  /** `null` = permanent (long-term); a timestamp = short-term expiry. */
  readonly expires_at: string | null;
  readonly updated_at: string;
  readonly ttl_seconds: number | null;
  readonly remaining_seconds: number | null;
  readonly expired: boolean;
  readonly short_term: boolean;
}

export interface MemoryChatOption {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
}

export interface MemoryDraft {
  readonly chat_id: string;
  readonly summary: string;
  readonly detail: string;
  /** Omit (or pass `null`) for a permanent entry. */
  readonly ttl_seconds?: number | null;
}

export interface MemoryUpdate {
  readonly summary?: string;
  readonly detail?: string;
  /** `null` promotes to permanent; omitted keeps the current expiry. */
  readonly ttl_seconds?: number | null;
}

export function listMemories(filters: ListFilters): Promise<Page<MemoryEntry>> {
  return call<Page<MemoryEntry>>(listPath('/memories', filters));
}

export function listMemoryChats(): Promise<{ items: readonly MemoryChatOption[] }> {
  return call<{ items: readonly MemoryChatOption[] }>('/memories/chats');
}

export function createMemory(draft: MemoryDraft): Promise<MemoryEntry> {
  return call<MemoryEntry>('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export function updateMemory(id: string, update: MemoryUpdate): Promise<MemoryEntry> {
  return call<MemoryEntry>(`/memories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
}

export function deleteMemory(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Panel-session-only image bytes used by `pwblob://` references in a memo detail. */
export function memoryBlobContentPath(id: string): string {
  return `/api/memories/blobs/${encodeURIComponent(id)}/content`;
}
