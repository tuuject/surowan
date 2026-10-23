import { call, type ChatSummary, type ListFilters, listPath, type Page } from './core.ts';

export interface MemoryEntry {
  readonly id: string;
  readonly conversation_id: string;
  readonly chat: ChatSummary;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly ttl_seconds: number;
  readonly remaining_seconds: number;
  readonly expired: boolean;
  readonly long_ttl: boolean;
}

export interface MemoryChatOption {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
}

export interface MemoryDraft {
  readonly chat_id: string;
  readonly message_thread_id: number;
  readonly content: string;
  readonly ttl_seconds: number;
}

export interface MemoryUpdate {
  readonly content?: string;
  readonly ttl_seconds?: number;
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
