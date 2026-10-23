import type { ContextMessageEntry } from './contexts.ts';
import { call, type ListFilters, listPath, type Page } from './core.ts';

/**
 * The chat an invocation ran in. Each host fills only its own identity: a
 * Telegram chat its `telegram_chat_id`, a Playground room its `room_id`.
 */
export interface InvocationChatSummary {
  readonly host_kind: 'telegram' | 'playground';
  readonly telegram_chat_id: string | null;
  readonly room_id: string | null;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
  readonly message_thread_id: number;
}

export interface InvocationListItem {
  readonly id: string;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly side_effect_started: boolean;
  readonly config_hash: string;
  readonly chat: InvocationChatSummary;
  readonly tool_call_count: number;
  /**
   * Daily-budget definition: input + output + cache read + cache write.
   * The cache counters are also listed on their own as a breakdown.
   */
  readonly total_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly total_cost: number | null;
}

export interface ToolCallEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments_json: string;
  readonly result_text: string | null;
  readonly state: string;
  readonly side_effect: boolean;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ModelCallEntry {
  readonly id: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly state: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  /** Input + output + cache read + cache write, the daily-budget definition. */
  readonly total_tokens: number;
  /** Raw provider `total_tokens`, kept for audit; not guaranteed to equal `total_tokens`. */
  readonly provider_total_tokens: number | null;
  readonly cost: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly request_json: string | null;
  readonly response_json: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly tools: readonly string[] | null;
}

export interface ToolRegistryEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
}

export interface AgentMessageEntry {
  readonly sequence_no: number;
  readonly role: string;
  readonly text: string;
  readonly thinking_text: string;
  readonly created_at: string;
}

export interface TelegramSendEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly kind: string;
  readonly request_json: string;
  readonly state: string;
  readonly telegram_message_id: string | null;
  /** The room's message sequence of a Playground delivery; null on Telegram. */
  readonly room_seq: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface InvocationDetail extends InvocationListItem {
  readonly bucket_id: string;
  readonly prompt_version: number;
  readonly tool_registry_hash: string | null;
  readonly tool_registry: readonly ToolRegistryEntry[] | null;
  readonly tool_calls: readonly ToolCallEntry[];
  readonly model_calls: readonly ModelCallEntry[];
  readonly agent_messages: readonly AgentMessageEntry[];
  readonly telegram_sends: readonly TelegramSendEntry[];
  readonly context_messages: readonly ContextMessageEntry[];
}

export function listInvocations(filters: ListFilters): Promise<Page<InvocationListItem>> {
  return call<Page<InvocationListItem>>(listPath('/invocations', filters));
}

export function getInvocation(id: string): Promise<InvocationDetail> {
  return call<InvocationDetail>(`/invocations/${encodeURIComponent(id)}`);
}
