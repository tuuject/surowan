import { call, type ChatSummary, type ListFilters, listPath, type Page } from './core.ts';

export interface SenderSummary {
  readonly display_name: string;
  readonly telegram_id: string | null;
  readonly telegram_type: string | null;
  readonly username: string | null;
  readonly is_bot?: boolean;
}

export interface MessageListItem {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revision_no: number | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly media_group_id: string | null;
  readonly sender: SenderSummary | null;
  readonly revision_count: number;
  readonly media_count: number;
}

export interface RevisionEntry {
  readonly id: string;
  readonly revision_no: number;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly service_json: string | null;
  readonly created_at: string;
  readonly sender: SenderSummary | null;
}

export interface MediaEntry {
  readonly id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly file_unique_id: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly analysis_state: string | null;
  readonly analysis_description: string | null;
}

export interface MessageDetail {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revisions: readonly RevisionEntry[];
  readonly media: readonly MediaEntry[];
}

export function listMessages(filters: ListFilters): Promise<Page<MessageListItem>> {
  return call<Page<MessageListItem>>(listPath('/messages', filters));
}

export function getMessage(id: string): Promise<MessageDetail> {
  return call<MessageDetail>(`/messages/${encodeURIComponent(id)}`);
}
