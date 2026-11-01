import { call, type ListFilters, listPath, type Page } from './core.ts';

/** A Chat the generated event memory belongs to. */
export interface GroupMemoryChat {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
}

/** One generated event summary with its inclusive Telegram message-id range. */
export interface GroupMemoryEntry {
  readonly id: string;
  readonly chat: GroupMemoryChat;
  readonly day: string;
  readonly summary: string;
  readonly first_message_id: string;
  readonly last_message_id: string;
  readonly created_at: string;
}

export interface GroupMemorySource {
  readonly text: string;
  readonly count: number;
  readonly first_message_id: string;
  readonly last_message_id: string;
}

export function listGroupMemories(filters: ListFilters): Promise<Page<GroupMemoryEntry>> {
  return call<Page<GroupMemoryEntry>>(listPath('/group-memories', filters));
}

export function updateGroupMemory(id: string, summary: string): Promise<GroupMemoryEntry> {
  return call<GroupMemoryEntry>(`/group-memories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary }),
  });
}

export function deleteGroupMemory(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/group-memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function groupMemorySource(id: string): Promise<GroupMemorySource> {
  return call<GroupMemorySource>(`/group-memories/${encodeURIComponent(id)}/messages`);
}
