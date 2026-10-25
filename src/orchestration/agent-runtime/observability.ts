import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ContextIdentity, Injection } from '../../context/builder/index.ts';
import type { ContextGcPlan } from '../../context/gc.ts';
import type { ContextHeader } from '../../context/store.ts';
import { serializeModelRequestForAudit } from '../../platform/models/request-audit.ts';
import { dailyUsage, modelCalls } from '../../store/schema/index.ts';
import { type DailyTokenBudget, meteredTokens } from '../../store/sleep.ts';
import type { RuntimeServices } from './types.ts';

export function logZzzExposure(invocationId: bigint, chatId: bigint, budget: DailyTokenBudget): void {
  console.log(
    JSON.stringify({
      event: 'agent_low_token_budget',
      invocation_id: invocationId.toString(),
      chat_id: chatId.toString(),
      used_tokens: budget.usedTokens.toString(),
      max_tokens: budget.maxTokens.toString(),
      at: new Date().toISOString(),
    }),
  );
  console.log(
    JSON.stringify({
      event: 'zzz_tool_exposed',
      invocation_id: invocationId.toString(),
      chat_id: chatId.toString(),
      at: new Date().toISOString(),
    }),
  );
}

export function logInvocationError(services: RuntimeServices, invocationId: bigint, error: unknown): void {
  try {
    console.log(
      JSON.stringify({
        event: 'agent_invocation_error',
        invocation_id: invocationId.toString(),
        error_name: error instanceof Error ? error.name : typeof error,
        error_message: services.secrets.redactError(error),
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // A failing log line must never replace the error it was meant to explain.
  }
}

export function logContextRebuilt(identity: ContextIdentity, systemPromptHash: string): void {
  console.log(
    JSON.stringify({
      event: 'context_rebuilt',
      conversation_id: identity.conversationId.toString(),
      chat_id: identity.chatId.toString(),
      thread_id: identity.threadId.toString(),
      system_prompt_hash: systemPromptHash,
      at: new Date().toISOString(),
    }),
  );
}

export function logContextRealigned(
  identity: ContextIdentity,
  header: ContextHeader,
  boundarySeq: bigint | null,
): void {
  console.log(
    JSON.stringify({
      event: 'context_realigned',
      conversation_id: identity.conversationId.toString(),
      chat_id: identity.chatId.toString(),
      head_seq: header.headSeq.toString(),
      boundary_seq: boundarySeq === null ? null : boundarySeq.toString(),
      cleared: boundarySeq === null,
      at: new Date().toISOString(),
    }),
  );
}

export function logContextInjected(
  invocationId: bigint,
  identity: ContextIdentity,
  bucketId: bigint,
  injection: Injection,
  seq: bigint,
): void {
  console.log(
    JSON.stringify({
      event: 'context_injected',
      invocation_id: invocationId.toString(),
      conversation_id: identity.conversationId.toString(),
      chat_id: identity.chatId.toString(),
      bucket_id: bucketId.toString(),
      seq: seq.toString(),
      checkpoint: true,
      message_count: injection.messageCount,
      history_count: injection.historyCount,
      omitted_new_messages: injection.omittedNewMessages,
      injections: Object.fromEntries(injection.injections.map((entry) => [entry.name, entry.count])),
      characters: injection.text.length,
      at: new Date().toISOString(),
    }),
  );
}

export function logContextGc(
  invocationId: bigint,
  header: ContextHeader,
  previousHeadSeq: bigint,
  plan: ContextGcPlan,
): void {
  console.log(
    JSON.stringify({
      event: 'context_gc',
      invocation_id: invocationId.toString(),
      conversation_id: header.conversationId.toString(),
      previous_head_seq: previousHeadSeq.toString(),
      head_seq: header.headSeq.toString(),
      target_seq: plan.targetSeq.toString(),
      before_tokens: plan.beforeTokens,
      after_tokens: plan.afterTokens,
      before_sends: plan.beforeSends,
      after_sends: plan.afterSends,
      before_messages: plan.beforeMessages,
      after_messages: plan.afterMessages,
      at: new Date().toISOString(),
    }),
  );
}

export function startModelCall(
  services: RuntimeServices,
  invocationId: bigint,
  model: Model<Api>,
  tools: readonly string[],
): bigint {
  const created = services.store.orm
    .insert(modelCalls)
    .values({
      invocationId,
      role: 'agent',
      provider: model.provider,
      model: model.id,
      attempt: 1n,
      state: 'pending',
      toolsJson: JSON.stringify(tools),
      createdAt: new Date().toISOString(),
    })
    .returning({ id: modelCalls.id })
    .get();
  if (created === undefined) {
    throw new Error('model_calls insert returned no row');
  }
  return created.id;
}

export function recordModelCallRequest(services: RuntimeServices, callId: bigint, payload: unknown): void {
  try {
    services.store.orm
      .update(modelCalls)
      .set({ requestJson: serializeModelRequestForAudit(payload) })
      .where(and(eq(modelCalls.id, callId), isNull(modelCalls.requestJson)))
      .run();
  } catch {
    // Snapshotting is best-effort auditing; never break the model call itself.
  }
}

export function recordModelCallResponse(
  services: RuntimeServices,
  callId: bigint,
  response: { status: number; headers: Record<string, string> },
): void {
  try {
    services.store.orm
      .update(modelCalls)
      .set({ responseJson: JSON.stringify({ status: response.status }) })
      .where(and(eq(modelCalls.id, callId), isNull(modelCalls.responseJson)))
      .run();
  } catch {
    // Same best-effort audit write as the request snapshot above.
  }
}

export function finishModelCall(
  services: RuntimeServices,
  callId: bigint,
  chatId: bigint,
  message: AssistantMessage,
  scope: 'chat' | 'playground',
): void {
  services.store.transaction(() => {
    const usage = message.usage;
    const now = new Date().toISOString();
    services.store.orm
      .update(modelCalls)
      .set({
        state: message.stopReason === 'error' || message.stopReason === 'aborted' ? 'error' : 'success',
        inputTokens: BigInt(usage.input),
        outputTokens: BigInt(usage.output),
        cacheReadTokens: BigInt(usage.cacheRead),
        cacheWriteTokens: BigInt(usage.cacheWrite),
        totalTokens: BigInt(usage.totalTokens),
        cost: usage.cost.total,
        errorCode:
          message.stopReason === 'error' ? 'model_error' : message.stopReason === 'aborted' ? 'model_aborted' : null,
        errorDetail: message.errorMessage === undefined ? null : services.secrets.redact(message.errorMessage),
        finishedAt: now,
      })
      .where(eq(modelCalls.id, callId))
      .run();
    services.store.orm
      .insert(dailyUsage)
      .values({
        utcDate: now.slice(0, 10),
        scope,
        resource: chatId.toString(),
        metric: 'model_tokens',
        amount: meteredTokens(usage),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [dailyUsage.utcDate, dailyUsage.scope, dailyUsage.resource, dailyUsage.metric],
        set: {
          amount: sql`${dailyUsage.amount} + excluded.amount`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
  });
}

export function failModelCall(services: RuntimeServices, callId: bigint, errorCode: string, error: unknown): void {
  services.store.orm
    .update(modelCalls)
    .set({
      state: 'error',
      errorCode,
      errorDetail: services.secrets.redactError(error),
      finishedAt: new Date().toISOString(),
    })
    .where(and(eq(modelCalls.id, callId), eq(modelCalls.state, 'pending')))
    .run();
}
