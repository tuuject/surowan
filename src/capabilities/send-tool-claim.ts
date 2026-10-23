/**
 * The reply policy and the claim: which reply targets this run already used,
 * and the write that records the pending send before it reaches the host.
 *
 * Split out of send-tool.ts's createSendTools closure. The query, the recheck
 * under the write lock and every audit write are unchanged.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Static } from 'typebox';
import { hostSends, invocations, toolCalls } from '../store/schema.ts';
import type { SendInputSchema, SendToolInput } from './send-tool.ts';
import { recentSendCount } from './send-tool-guards.ts';
import { recordRejectedSend } from './send-tool-record.ts';
import type { SendToolEnvironment } from './send-tool-support.ts';

/**
 * Whether this reply target already received a reply, is still pending, or has
 * an unknown outcome. A rejection is recorded here, so the caller only decides
 * what to throw.
 */
export function rejectDuplicateReply(
  environment: SendToolEnvironment,
  toolCallId: string,
  input: Static<typeof SendInputSchema>,
  send: SendToolInput,
  targetConversationId: bigint,
): { readonly error: string } | undefined {
  if (environment.allowReplyMessageMultipleTimes !== true && send.reply_to_message_id !== undefined) {
    const previous = environment.store.orm
      .select({ state: hostSends.state })
      .from(hostSends)
      .where(
        and(
          eq(hostSends.conversationId, targetConversationId),
          sql`json_extract(${hostSends.requestJson}, '$.reply_to_message_id') = ${send.reply_to_message_id}`,
          sql`${hostSends.state} IN ('success', 'pending', 'outcome_unknown')`,
        ),
      )
      // A success does not resolve another pending or uncertain attempt.
      .orderBy(sql`${hostSends.state} = 'success'`)
      .limit(1)
      .get();
    if (previous !== undefined) {
      const errorCode = previous.state === 'success' ? 'reply_already_sent' : 'reply_delivery_unknown';
      recordRejectedSend(environment, toolCallId, input, errorCode);
      return {
        error:
          previous.state === 'success'
            ? 'Not sent: reply_already_sent. This message has already been replied to. Do not send another reply or bypass this by omitting or changing reply_to_message_id.'
            : 'Not sent: reply_delivery_unknown. An earlier reply to this message is pending or has an unknown outcome. Do not retry or bypass this by omitting or changing reply_to_message_id.',
      };
    }
  }
  return undefined;
}

/**
 * Writes the pending tool call and its host send in one transaction, rechecking
 * the reply policy under the write lock. Returns the claimed row ids, or the
 * error the caller must fail the send with.
 */
export function claimSend(
  environment: SendToolEnvironment,
  toolCallId: string,
  input: Static<typeof SendInputSchema>,
  send: SendToolInput,
  targetConversationId: bigint,
  generationPictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>,
): { readonly toolId: bigint; readonly sendId: bigint } | { readonly error: string } {
  return environment.store.transaction(() => {
    // Recheck under the write lock and claim with the pending send atomically.
    // The retained audit survives context resets and restarts.
    const duplicate = rejectDuplicateReply(environment, toolCallId, input, send, targetConversationId);
    if (duplicate !== undefined) {
      return duplicate;
    }
    const now = new Date().toISOString();
    const createdToolCall = environment.store.orm
      .insert(toolCalls)
      .values({
        invocationId: environment.context.invocationId,
        toolCallId,
        toolName: 'send',
        argumentsJson: JSON.stringify(send),
        state: 'pending',
        sideEffect: true,
        createdAt: now,
      })
      .returning({ id: toolCalls.id })
      .get();
    if (createdToolCall === undefined) {
      throw new Error('tool_calls insert returned no row');
    }
    const toolId = createdToolCall.id;
    if (recentSendCount(environment, new Date()) >= environment.sendRateLimit.sendsPerWindow) {
      environment.store.orm
        .update(toolCalls)
        .set({ state: 'error', errorCode: 'send_rate_limited', finishedAt: now })
        .where(eq(toolCalls.id, toolId))
        .run();
      return {
        error: `send rate limit of ${environment.sendRateLimit.sendsPerWindow} per ${environment.sendRateLimit.windowSeconds}s window reached`,
      };
    }
    // Audit counters, not a limit: the sliding window above is the brake.
    // `side_effect_started` marks the invocation from the moment a send is
    // attempted, which is what turns a crash into `outcome_unknown`.
    environment.store.orm
      .update(invocations)
      .set({ sendsUsed: sql`${invocations.sendsUsed} + 1`, sideEffectStarted: true })
      .where(eq(invocations.id, environment.context.invocationId))
      .run();
    const createdSend = environment.store.orm
      .insert(hostSends)
      .values({
        toolCallId: toolId,
        conversationId: targetConversationId,
        kind: send.kind,
        requestJson: JSON.stringify({
          kind: send.kind,
          reply_to_message_id: send.reply_to_message_id ?? null,
          ...(send.kind === 'image'
            ? {
                generation_id: send.image_generation_id,
                pictures: generationPictures?.length ?? 0,
                asset_ids: generationPictures?.map((picture) => picture.assetId) ?? [],
                resend: send.resend === true,
              }
            : {}),
        }),
        state: 'pending',
        createdAt: now,
      })
      .returning({ id: hostSends.id })
      .get();
    if (createdSend === undefined) {
      throw new Error('host_sends insert returned no row');
    }
    return { toolId, sendId: createdSend.id };
  });
}
