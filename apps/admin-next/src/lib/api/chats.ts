import { call, writeHeaders } from './core.ts';
import type { AbortRunningOption, ModelApplySummary, ThinkingLevel } from './models.ts';
import type { AgentModelReference, ProviderModelReference } from './providers.ts';

export interface ParticipationWindow {
  readonly start: string;
  readonly end: string;
  /** ISO weekdays 1 (Monday) through 7 (Sunday); omitted means every day. */
  readonly days?: readonly number[];
}

/** The chat-level `participation` section; `null` when the chat configures none. */
export interface ParticipationView {
  readonly ask_only?: boolean;
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

/** The Chat's entry gate override; only the fields this Chat actually sets. */
export interface ChatDecisionGateView {
  readonly enabled?: boolean;
  readonly mode?: 'shadow' | 'enforce';
  readonly threshold?: number;
  readonly history_messages?: number;
  readonly pending_messages?: number;
  readonly instructions?: string;
}

/** One field of a Chat gate patch: `null` returns that field to the global value. */
export type DecisionGateChatPatch = {
  readonly [K in keyof ChatDecisionGateView]?: ChatDecisionGateView[K] | null;
};

/** How a dated group-memory search reads its date; absent means `off`. */
export type ThirtyHourClock = 'off' | 'non_overlapping' | 'overlapping';

export interface GroupMemoryView {
  readonly enabled: boolean;
  readonly idle_minutes?: number;
  readonly thirty_hour_clock?: ThirtyHourClock;
}

/** One per-Chat MCP binding; `null` inherits every configured server. */
export interface McpChatBindingView {
  readonly server: string;
  readonly tools?: '*' | readonly string[];
  readonly tool_policies?: readonly {
    readonly name: string;
    readonly read_only: boolean;
    readonly timeout_seconds: number;
  }[];
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
  readonly group_memory: GroupMemoryView | null;
  readonly proactive_reply: ProactiveReplyView | null;
  readonly effective_proactive_reply: ProactiveReplySettingsView;
  readonly decision_gate: ChatDecisionGateView | null;
  readonly timezone: string | null;
  readonly mcp: readonly McpChatBindingView[] | null;
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
  /** Invocations an update stopped because they still ran on the replaced model. */
  readonly aborted_invocations?: number;
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

export function updateChat(
  id: string,
  body: ChatSettings & AbortRunningOption,
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

/** `active_windows: null` removes the chat's windows; an empty array keeps the gate with no schedule. */
export function updateChatParticipation(
  id: string,
  body: { readonly active_windows?: readonly ParticipationWindow[] | null; readonly ask_only?: boolean | null },
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}/participation`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

/**
 * Omit `idle_minutes` or `thirty_hour_clock` to keep the stored value;
 * `idle_minutes: null` and `thirty_hour_clock: 'off'` remove it.
 */
export function updateChatGroupMemory(
  id: string,
  body: {
    readonly enabled: boolean;
    readonly idle_minutes?: number | null;
    readonly thirty_hour_clock?: ThirtyHourClock;
  },
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}/group-memory`, {
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

/**
 * Per-field patch of the Chat's gate override: an omitted field is kept, and
 * `null` removes it (all six removed deletes the whole override).
 */
export function updateChatDecisionGate(
  id: string,
  body: DecisionGateChatPatch,
  revision: string,
): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}/decision-gate`, {
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
