import { call, type ListFilters, listPath, type Page } from './core.ts';

export interface AlarmChatSummary {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly message_thread_id: string;
}

export interface AlarmListItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: string | null;
  readonly fired_at: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: boolean;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly chat: AlarmChatSummary;
}

export function listAlarms(filters: ListFilters): Promise<Page<AlarmListItem>> {
  return call<Page<AlarmListItem>>(listPath('/alarms', filters));
}

export function cancelAlarm(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/alarms/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
