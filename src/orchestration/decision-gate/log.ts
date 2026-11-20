import type { DecisionRecord, DecisionToken } from './types.ts';

/**
 * The `agent_decision_gate` log line: one per finished decision, modelled on
 * `agent_proactive_reply_sampled`. Field names and order are the operator's
 * contract — no message text, and every detail is redacted before it arrives.
 */
export type DecisionEvent = Record<string, string | number | boolean | null>;

export function decisionEvent(token: DecisionToken, record: DecisionRecord, applied: boolean, at: Date): DecisionEvent {
  const plan = token.plan;
  return {
    event: 'agent_decision_gate',
    chat_id: token.candidate.hostChatId.toString(),
    conversation_id: token.candidate.conversationId.toString(),
    bucket_id: token.candidate.bucketId.toString(),
    decision_id: token.decisionId.toString(),
    mode: token.settings.mode,
    model: token.settings.model,
    state: record.state,
    outcome: record.outcome,
    applied,
    probability: record.probability,
    threshold: record.threshold,
    history_count: plan.kind === 'request' ? Number(plan.content.historyCount) : null,
    pending_count: plan.kind === 'request' ? Number(plan.content.pendingCount) : null,
    input_tokens: record.inputTokens === null ? null : Number(record.inputTokens),
    cost: record.cost,
    duration_ms: record.durationMs === null ? null : Number(record.durationMs),
    error_code: record.errorCode,
    error_detail: record.errorDetail,
    at: at.toISOString(),
  };
}

/**
 * A failure that never produced a verdict: phase 1 threw, or the settle path
 * itself failed. The decision id, mode and model are missing when the failure
 * happened before they were known.
 */
export function failureEvent(input: {
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly bucketId: bigint;
  readonly decisionId: bigint | null;
  readonly mode: string | null;
  readonly model: string | null;
  readonly applied: boolean;
  /** Already redacted. */
  readonly detail: string;
  readonly at: Date;
}): DecisionEvent {
  return {
    event: 'agent_decision_gate',
    chat_id: input.chatId.toString(),
    conversation_id: input.conversationId.toString(),
    bucket_id: input.bucketId.toString(),
    decision_id: input.decisionId?.toString() ?? null,
    mode: input.mode,
    model: input.model,
    state: 'error',
    outcome: 'enter',
    applied: input.applied,
    error_code: 'internal_error',
    error_detail: input.detail,
    at: input.at.toISOString(),
  };
}

/**
 * A broken log sink (a closed stdout, EPIPE) must not travel back into the state
 * machine: the audit row is already committed, and a throw here would settle the
 * same verdict twice.
 */
export function writeEvent(fields: Readonly<DecisionEvent>): void {
  try {
    console.log(JSON.stringify(fields));
  } catch {
    // Nothing left to report to.
  }
}
