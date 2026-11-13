import { call, type ListFilters, listPath, type Page, postJson, writeHeaders } from './core.ts';

export type RecurringInputMode = 'builder' | 'cron';

export interface RecurringTarget {
  readonly conversation_id: string;
  readonly chat_id: string;
  readonly host_kind: string;
  readonly telegram_chat_id: string | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: string;
}

export interface RecurringFiring {
  readonly id: string;
  readonly source: 'schedule' | 'manual';
  readonly occurrence_at: string;
  readonly outcome: 'scheduled' | 'skipped';
  readonly skip_reason: string | null;
  readonly coalesced: number;
  readonly triggered_by: string | null;
  readonly created_at: string;
  readonly task_id: string | null;
  readonly receipt_state: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
}

export interface RecurringAlarm {
  readonly id: string;
  /** The alarm's own optimistic-lock token, echoed via `If-Match` on edit. */
  readonly revision: string;
  readonly title: string;
  readonly prompt: string;
  readonly rules: readonly string[];
  readonly input_mode: RecurringInputMode;
  readonly time_zone: string;
  readonly enabled: boolean;
  readonly next_fire_at: string | null;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly target: RecurringTarget;
  readonly last_firing: RecurringFiring | null;
}

export interface RecurringAlarmDetail extends RecurringAlarm {
  readonly firings: readonly RecurringFiring[];
}

export interface RecurringTargetOption {
  readonly chat_id: string;
  readonly message_thread_id: string;
  readonly conversation_id: string | null;
  readonly host_kind: string;
  readonly telegram_chat_id: string | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface RecurringTargets {
  readonly items: readonly RecurringTargetOption[];
  readonly default_time_zone: string;
}

export interface RecurringDraft {
  readonly title: string;
  readonly prompt: string;
  readonly rules: readonly string[];
  readonly input_mode: RecurringInputMode;
  readonly time_zone: string;
  readonly enabled: boolean;
}

export interface RuleIssue {
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

export interface RecurringPreview {
  readonly next: readonly string[];
  readonly issues: readonly RuleIssue[];
  readonly time_zone: string | null;
  readonly short_interval: boolean;
}

export interface RecurringRun {
  readonly firing_id: string;
  readonly task_id: string;
  readonly occurrence_at: string;
}

export function listRecurringAlarms(filters: ListFilters): Promise<Page<RecurringAlarm>> {
  return call<Page<RecurringAlarm>>(listPath('/recurring-alarms', filters));
}

export function getRecurringAlarm(id: string): Promise<RecurringAlarmDetail> {
  return call<RecurringAlarmDetail>(`/recurring-alarms/${encodeURIComponent(id)}`);
}

export function listRecurringTargets(): Promise<RecurringTargets> {
  return call<RecurringTargets>('/recurring-alarms/targets');
}

export function previewRecurringSchedule(input: {
  readonly rules: readonly string[];
  readonly time_zone: string;
}): Promise<RecurringPreview> {
  return postJson<RecurringPreview>('/recurring-alarms/preview', input);
}

export function createRecurringAlarm(
  input: RecurringDraft & { readonly chat_id: string; readonly message_thread_id: string },
): Promise<RecurringAlarm> {
  return postJson<RecurringAlarm>('/recurring-alarms', input);
}

export function updateRecurringAlarm(id: string, draft: RecurringDraft, revision: string): Promise<RecurringAlarm> {
  return call<RecurringAlarm>(`/recurring-alarms/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(draft),
  });
}

export function deleteRecurringAlarm(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/recurring-alarms/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function runRecurringAlarm(id: string): Promise<RecurringRun> {
  return postJson<RecurringRun>(`/recurring-alarms/${encodeURIComponent(id)}/run`, {});
}

export function draftFromAlarm(alarm: RecurringAlarm): RecurringDraft {
  return {
    title: alarm.title,
    prompt: alarm.prompt,
    rules: alarm.rules,
    input_mode: alarm.input_mode,
    time_zone: alarm.time_zone,
    enabled: alarm.enabled,
  };
}
