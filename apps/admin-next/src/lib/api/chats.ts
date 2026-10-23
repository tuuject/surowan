import { call, writeHeaders } from './core.ts';
import type { ModelApplySummary, ThinkingLevel } from './models.ts';
import type { AgentModelReference, ProviderModelReference } from './providers.ts';

export interface ParticipationWindow {
  readonly start: string;
  readonly end: string;
  /** ISO weekdays 1 (Monday) through 7 (Sunday); omitted means every day. */
  readonly days?: readonly number[];
}

/** The chat-level `participation` section; `null` when the chat configures none. */
export interface ParticipationView {
  readonly active_windows?: readonly ParticipationWindow[];
  readonly trigger_keywords?: readonly string[];
  readonly attention_window_seconds?: number;
}

export interface ProactiveReplyView {
  readonly enabled?: boolean;
  readonly base_probability?: number;
  readonly increment?: number;
  readonly hard_pity?: number;
}

export interface ProactiveReplySettingsView {
  readonly enabled: boolean;
  readonly base_probability: number;
  readonly increment: number;
  readonly hard_pity: number;
}

export type ProactiveReplyWrite =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'off' }
  | {
      readonly mode: 'custom';
      readonly base_probability: number;
      readonly increment: number;
      readonly hard_pity: number;
    };

export interface ChatSettings {
  readonly topic_ids: readonly string[] | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: ThinkingLevel | null;
}

export interface ChatSettingsView extends ChatSettings {
  readonly participation: ParticipationView | null;
  readonly proactive_reply: ProactiveReplyView | null;
  readonly effective_proactive_reply: ProactiveReplySettingsView;
  readonly timezone: string | null;
  readonly effective: AgentModelReference;
}

export interface ChatEntry {
  readonly id: string;
  readonly runtime_chat_id: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly saved: ChatSettingsView | null;
  readonly active: ChatSettingsView | null;
}

export interface ChatsView {
  readonly revision: string;
  readonly supervised: boolean;
  readonly restart_required: readonly string[];
  /** Global default timezone; per-chat overrides ride on each item. */
  readonly timezone: string;
  readonly global_participation: ParticipationView | null;
  readonly global_proactive_reply: ProactiveReplyView | null;
  readonly effective_global_proactive_reply: ProactiveReplySettingsView;
  readonly defaults: AgentModelReference;
  readonly models: readonly (ProviderModelReference & {
    readonly name: string;
    readonly thinking_levels: readonly ThinkingLevel[];
  })[];
  readonly items: readonly ChatEntry[];
}

export interface ChatWriteResponse extends ChatsView {
  readonly apply: ModelApplySummary;
}

export function getChats(): Promise<ChatsView> {
  return call<ChatsView>('/chats');
}

export function createChat(body: ChatSettings & { readonly id: string }, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>('/chats', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateChat(id: string, body: ChatSettings, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

/** `active_windows: null` removes the chat's windows; an empty array keeps the gate with no schedule. */
export function updateChatParticipation(
  id: string,
  body: { readonly active_windows: readonly ParticipationWindow[] | null },
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}/participation`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateChatProactiveReply(
  id: string,
  body: ProactiveReplyWrite,
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}/proactive-reply`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function deleteChat(id: string, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}
