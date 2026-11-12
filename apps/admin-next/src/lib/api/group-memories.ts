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

export type GroupMemoryLane = 'live' | 'backfill';

/** One consolidation lane: `live` follows new messages, `backfill` works through an old backlog. */
export interface GroupMemoryLaneProgress {
  readonly lane: GroupMemoryLane;
  readonly through_message_id: string;
  readonly through_at: string | null;
  readonly until_message_id: string | null;
  readonly until_at: string | null;
  readonly pending: number;
  readonly state: 'idle' | 'running';
  readonly last_attempt_at: string | null;
  readonly last_success_at: string | null;
  readonly next_attempt_at: string | null;
  readonly error_code: string | null;
  readonly consecutive_failures: number;
}

export interface GroupMemoryProgressItem {
  readonly chat: GroupMemoryChat;
  readonly lanes: readonly GroupMemoryLaneProgress[];
  readonly memories: { readonly count: number; readonly latest_day: string | null };
  readonly newest_message_at: string | null;
  readonly runs_24h: { readonly success: number; readonly error: number; readonly model_calls: number };
  readonly last_error: {
    readonly code: string;
    readonly detail: string | null;
    readonly lane: GroupMemoryLane;
    readonly day: string;
    readonly at: string;
  } | null;
}

/** One consolidation batch and how it ended. */
export interface GroupMemoryRun {
  readonly id: string;
  readonly chat: GroupMemoryChat;
  readonly lane: GroupMemoryLane;
  readonly day: string;
  readonly first_message_id: string;
  readonly through_message_id: string;
  readonly messages: number;
  readonly state: 'running' | 'success' | 'error';
  readonly events: number | null;
  readonly model_calls: number;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export function getGroupMemoryProgress(): Promise<{ readonly items: readonly GroupMemoryProgressItem[] }> {
  return call<{ readonly items: readonly GroupMemoryProgressItem[] }>('/group-memories/progress');
}

export function listGroupMemoryRuns(filters: ListFilters): Promise<Page<GroupMemoryRun>> {
  return call<Page<GroupMemoryRun>>(listPath('/group-memories/runs', filters));
}
