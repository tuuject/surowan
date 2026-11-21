import type { DecisionGateSettings } from '../../platform/decision-gate.ts';
import type { FileChat } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { SecretStore } from '../../platform/secrets.ts';

/**
 * The live bot identity the gate reads at every decision. Production passes the
 * connection's own identity object: its getters read the identity kept in
 * memory from the last `getMe`, so a hot-swapped token changes the name without
 * a reload. Never copy these fields into strings at construction.
 */
export interface DecisionGateBot {
  readonly id: bigint;
  readonly displayName: string;
  readonly username: string | null;
}

export interface DecisionGateOptions {
  readonly bot: DecisionGateBot;
  /** Resolves `api_key` on every decision; never cached, so a rotated entry applies immediately. */
  readonly secrets: SecretStore;
  /** Wakes the scheduler after phase 2 changed a deadline. */
  readonly wake: () => void;
  /** Test seam; production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Global in-flight cap; a batch above it enters instead of queueing. */
  readonly maxConcurrent?: number | undefined;
  /** How often one batch may be decided again after new messages arrived. */
  readonly maxRedecisions?: number | undefined;
}

/**
 * What the due pass knows about one batch. Everything here is read inside the
 * due transaction, so the decision describes the batch as it was frozen.
 */
export interface DecisionCandidate {
  readonly bucketId: bigint;
  readonly conversationId: bigint;
  readonly bucketKind: string;
  readonly hostChatId: bigint;
  readonly hostKind: HostKind;
  readonly chatType: string;
  readonly chat: Pick<FileChat, 'decision_gate'>;
  /** Participation keywords of the Chat; a direct cue anywhere skips the gate. */
  readonly keywords: readonly string[];
  readonly now: Date;
}

export interface DecisionMessage {
  readonly from: string;
  /** `text` or `caption`, cut to 500 characters and prefixed with `[kind]`. */
  readonly text: string;
  readonly reply_to?: string | undefined;
}

/** The Decisions API `state`: the messages go here, never into the instructions. */
export interface DecisionState {
  readonly bot: { readonly name: string; readonly username: string };
  readonly history: readonly DecisionMessage[];
  readonly pending: readonly DecisionMessage[];
}

export interface DecisionContent {
  readonly state: DecisionState;
  readonly historyCount: bigint;
  readonly pendingCount: bigint;
}

export type DecisionPlan =
  | { readonly kind: 'request'; readonly content: DecisionContent; readonly fingerprint: string }
  /** Settled without a request: the in-flight cap was already reached. */
  | { readonly kind: 'settled'; readonly record: DecisionRecord; readonly applied: boolean };

/** The columns a finished decision writes; `state` may still be rewritten to `stale`. */
export interface DecisionRecord {
  readonly state: 'success' | 'error' | 'stale';
  readonly outcome: 'enter' | 'drop' | null;
  readonly probability: number | null;
  readonly threshold: number;
  readonly inputTokens: bigint | null;
  readonly cost: number | null;
  readonly durationMs: bigint | null;
  readonly errorCode: string | null;
  /** Already redacted by whoever built the record. */
  readonly errorDetail: string | null;
}

/** One decision phase 1 committed to; the request starts after the transaction commits. */
export interface DecisionToken {
  readonly decisionId: bigint;
  readonly candidate: DecisionCandidate;
  readonly settings: DecisionGateSettings;
  /** The rendered question, with the bot name read at decision time. */
  readonly instructions: string;
  readonly plan: DecisionPlan;
}

/**
 * The two ways a due batch leaves `begin`: held for the verdict (`enforce`), or
 * decided in the background while the ordinary path continues (`shadow`; in
 * `enforce` this only happens for a batch that entered because the in-flight cap
 * was reached).
 */
export interface DecisionBegin {
  /** True when `enforce` withholds the batch until the verdict arrives. */
  readonly held: boolean;
  /** The decision to start after the commit; missing when a request is already in flight. */
  readonly token: DecisionToken | undefined;
}
