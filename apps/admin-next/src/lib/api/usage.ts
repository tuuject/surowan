import { call } from './core.ts';

export interface LabelCount {
  readonly label: string;
  readonly count: number;
}

export interface UsageEntry {
  readonly resource: string;
  readonly metric: string;
  readonly scope: string;
  readonly amount: number;
}

export interface CancelOngoingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
}

export interface WakeResult {
  readonly status: 'awake';
  readonly was_sleeping: boolean;
}

export interface PausedChat {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
  readonly paused_at: string;
}

export interface RuntimeStatus {
  readonly sleeping: boolean;
  readonly sleep_until: string | null;
  readonly paused_chats: readonly PausedChat[];
}

export interface Overview {
  readonly generated_at: string;
  readonly invocation_states: readonly LabelCount[];
  readonly sticker_index_states: readonly LabelCount[];
  readonly top_tools: readonly LabelCount[];
  readonly daily_usage: readonly UsageEntry[];
  readonly runtime_status: RuntimeStatus;
  readonly message_count: number;
  readonly cached_analysis_count: number;
}

export interface UsageResponse {
  readonly days: number;
  readonly series: readonly UsagePoint[];
}

export interface UsagePoint {
  readonly date: string;
  readonly model_tokens: number;
  readonly vision_tokens: number;
  readonly tool_calls: number;
  readonly agent_invocations: number;
}

export function getOverview(): Promise<Overview> {
  return call<Overview>('/overview');
}

export function cancelOngoingSessions(): Promise<CancelOngoingResult> {
  return call<CancelOngoingResult>('/cancel-ongoing-sessions', { method: 'POST' });
}

export function wakeBot(): Promise<WakeResult> {
  return call<WakeResult>('/wake', { method: 'POST' });
}

export function getUsage(days: number): Promise<UsageResponse> {
  return call<UsageResponse>(`/usage?days=${encodeURIComponent(String(days))}`);
}
