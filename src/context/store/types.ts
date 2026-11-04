import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextMessageRole } from '../codec.ts';
import type { MemoStateUpdate } from '../memo-pad/index.ts';

/**
 * Live handle of one Conversation Context. It is mutated by the store as the
 * history advances, so every consumer (tools, GC, attach path) observes the
 * same `head_seq` / `next_seq` without re-reading the row.
 */
export interface ContextHeader {
  readonly id: bigint;
  readonly conversationId: bigint;
  headSeq: bigint;
  nextSeq: bigint;
  sendCountTotal: bigint;
  systemPromptHash: string;
  /**
   * Canonical-reset generation. A writer holding a header from before a reset
   * must not append or move the head; the store rejects it instead of letting
   * an aborted run resurrect the discarded transcript.
   */
  generation: bigint;
  /** Model window the retained transcript was built under; NULL for pre-052 rows. */
  contextWindow: bigint | null;
  maxOutputTokens: bigint | null;
  lastGcAt: string | null;
  /** Batch seq that carried the last full short-term Memo list. */
  memoRefreshSeq: bigint | null;
  /** Short-term Memo state already announced to this Context. */
  memoStateJson: string | null;
  /** Set when the next batch must re-render the full list regardless of seq. */
  memoRefreshPending: boolean;
}

/**
 * The model budget one run's retained transcript must fit. The store compares
 * it with the budget recorded when the Context was built: when `context_window`
 * or `max_tokens` changed and the retained tokens no longer fit
 * `maxRetainedTokens`, the canonical history is rebuilt from chat history on
 * this run's first open.
 */
export interface ContextBudget {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Retained transcript tokens that still fit this run's prompt budget. */
  readonly maxRetainedTokens: number;
}

export type ContextRebuildReason = 'system_prompt' | 'context_window';

export interface OpenContextOptions {
  readonly budget?: ContextBudget;
  readonly now?: Date;
}

/** A writer tried to use a header from before a canonical reset. */
export class StaleContextError extends Error {
  override readonly name = 'StaleContextError';

  constructor(contextId: bigint) {
    super(`Conversation Context ${contextId} was rebuilt; refusing a stale write`);
  }
}

export interface ContextMessageInput {
  readonly invocationId: bigint | null;
  readonly isCheckpoint: boolean;
  readonly estTokens: number;
  readonly json: string;
  readonly role: ContextMessageRole;
  /** Set when this row is the tool result of a successful `send`. */
  readonly countedSend?: boolean;
  /** Announced with this checkpoint, atomically with its canonical message. */
  readonly memoState?: MemoStateUpdate & { readonly refresh: boolean };
}

/** Light row projection used by GC and `/status`; never carries payloads. */
export interface ContextWindowRow {
  readonly seq: bigint;
  readonly role: string;
  readonly estTokens: bigint;
  readonly isCheckpoint: boolean;
  readonly sendSeq: bigint | null;
}

export interface RetainedContextMessage {
  readonly seq: bigint;
  readonly message: AgentMessage;
}

export interface ContextStats {
  readonly headSeq: bigint;
  readonly nextSeq: bigint;
  readonly messageCount: number;
  readonly retainedSends: number;
  readonly retainedTokens: number;
  readonly lastGcAt: string | null;
}

export interface ConversationContextSummary {
  readonly conversationId: bigint;
  readonly telegramChatId: bigint;
  readonly messageThreadId: bigint;
  readonly headSeq: bigint;
  readonly nextSeq: bigint;
  readonly sendCountTotal: bigint;
  readonly messageCount: bigint;
  readonly lastActiveAt: string;
  readonly lastGcAt: string | null;
  readonly activeInvocationId: bigint | null;
}
