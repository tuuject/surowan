import { call, type ListFilters, listPath, type Page } from './core.ts';

export interface ContextMessageEntry {
  readonly section: string;
  readonly sequence_no: number;
  readonly message_id: string;
  readonly revision_id: string;
  readonly omitted_before: number;
  readonly snapshot_json: string;
}

export interface ConversationContextListItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly telegram_chat_id: string;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: number;
  readonly head_seq: number;
  readonly next_seq: number;
  readonly send_count_total: number;
  readonly message_count: number;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: string | null;
}

export interface ConversationContextMessageEntry {
  readonly seq: number;
  readonly role: string;
  readonly is_checkpoint: boolean;
  readonly send_seq: number | null;
  readonly est_tokens: number;
  readonly invocation_id: string | null;
  readonly evicted_at: string | null;
  readonly created_at: string;
  readonly payload_preview: string;
  readonly payload_truncated: boolean;
}

export interface ConversationContextRefEntry {
  readonly ref: string;
  readonly kind: string;
  readonly source_seq: number;
  readonly expires_at: string;
}

export interface ConversationContextDetail extends ConversationContextListItem {
  readonly system_prompt_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly messages: readonly ConversationContextMessageEntry[];
  readonly refs: readonly ConversationContextRefEntry[];
}

export function listConversationContexts(filters: ListFilters): Promise<Page<ConversationContextListItem>> {
  return call<Page<ConversationContextListItem>>(listPath('/contexts', filters));
}

export function getConversationContext(conversationId: string): Promise<ConversationContextDetail> {
  return call<ConversationContextDetail>(`/contexts/${encodeURIComponent(conversationId)}`);
}
