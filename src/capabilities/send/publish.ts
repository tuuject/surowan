/**
 * The second half of one send: hand the claimed message to the host, follow its
 * retry and barrier rules, then mark the audit rows accepted and record the
 * message the conversation now holds.
 *
 * Split out of send-tool.ts's createSendTools closure; the delivery loop, its
 * retry and barrier semantics, and the record order are unchanged.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { Static } from 'typebox';
import type { ImDeliveredMessage } from '../../platform/im-host.ts';
import { hostSends, toolCalls } from '../../store/schema/index.ts';
import { prepareSend, type PreparedSend } from './deliver.ts';
import { markSendFailed, recordOutgoingMessage } from './record.ts';
import type { SendInputSchema } from './index.ts';
import {
  DeliveryRejected,
  reportsWireIds,
  resolveOutgoingPart,
  SEND_BARRIER_TEXT,
  sentDetails,
  sentMessageResult,
  type SendDetails,
  type SendToolEnvironment,
} from './support.ts';

/** A 429 retry that the send barrier stopped before it reached Telegram. */
class SendHeldBack extends Error {}

/** Delivers one message through the full send pipeline: checks, audit, barrier and Telegram. */
export async function deliverSend(
  environment: SendToolEnvironment,
  mentionedTasks: Set<bigint>,
  toolCallId: string,
  input: Static<typeof SendInputSchema>,
  signal: AbortSignal | undefined,
  options: { readonly barrier: boolean },
): Promise<{ content: { type: 'text'; text: string }[]; details: SendDetails }> {
  const outcome = prepareSend(environment, mentionedTasks, toolCallId, input, signal, options);
  if (outcome.kind === 'replay') {
    return outcome.result;
  }
  return publishSend(environment, mentionedTasks, outcome.prepared, signal, options);
}

async function publishSend(
  environment: SendToolEnvironment,
  mentionedTasks: Set<bigint>,
  prepared: PreparedSend,
  signal: AbortSignal | undefined,
  options: { readonly barrier: boolean },
): Promise<{ content: { type: 'text'; text: string }[]; details: SendDetails }> {
  const { barrier } = options;
  const {
    target,
    targetConversationId,
    send,
    textPart,
    stickerFileId,
    generationPictures,
    composedText,
    mention,
    completion,
    toolId,
    sendId,
  } = prepared;
  const outgoingPart = resolveOutgoingPart({ textPart, stickerFileId, generationPictures, send });
  const replyToMessageId = send.reply_to_message_id === undefined ? undefined : BigInt(send.reply_to_message_id);
  const startedAt = performance.now();
  let delivered: ImDeliveredMessage;
  let recordedByHost = false;
  try {
    while (true) {
      const outcome = await environment.host.delivery.deliver({
        target,
        parts: [outgoingPart],
        sendId,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        signal,
      });
      if (outcome.kind === 'delivered') {
        const [first] = outcome.messages;
        if (first === undefined) {
          throw new Error('the host reported a delivery without a message');
        }
        delivered = first;
        recordedByHost = outcome.recordedByHost;
        break;
      }
      const retryAfter = outcome.failure.retryAfterSeconds;
      if (outcome.failure.reason !== 'rate_limited' || retryAfter === undefined) {
        throw new DeliveryRejected(outcome.failure);
      }
      if (Date.now() + retryAfter * 1000 >= environment.deadline) {
        throw new DeliveryRejected(outcome.failure);
      }
      await delay(retryAfter * 1000, undefined, { signal });
      // Messages that arrived during the wait make this reply stale, just
      // as they would have before the first attempt.
      if (barrier && environment.holdForNewMessages?.() === true) {
        throw new SendHeldBack();
      }
    }
  } catch (error) {
    const held = error instanceof SendHeldBack;
    const failure = error instanceof DeliveryRejected ? error.failure : undefined;
    const unknown = failure?.outcomeUnknown ?? false;
    const errorCode = held
      ? 'send_barrier'
      : failure !== undefined
        ? failure.code
        : signal?.aborted
          ? 'aborted'
          : 'send_error';
    // The host's description is what tells the model how to fix the send
    // (an unescaped markup character, a reply target that is gone); the
    // status code alone leaves it nothing to correct. Only host-reported
    // rejections carry one worth showing; transport errors stay opaque.
    const hostReported =
      failure !== undefined &&
      (failure.reason === 'permanent' || failure.reason === 'transient' || failure.reason === 'rate_limited');
    const reason = held
      ? SEND_BARRIER_TEXT
      : `${unknown ? 'Telegram send outcome is unknown' : `Telegram send failed: ${errorCode}`}${
          hostReported ? ` (${failure.description})` : ''
        }`;
    markSendFailed(environment, { toolId, sendId, errorCode, unknown, reason, startedAt });
    throw new Error(reason);
  }
  if (mention !== null && completion !== null) {
    mentionedTasks.add(completion.taskId);
  }
  // The host has accepted the message from here on. A failure to record it
  // must not read as a failed send, or the model would send it again.
  const now = new Date().toISOString();
  const markAccepted = (): void => {
    environment.store.orm
      .update(toolCalls)
      .set({
        state: 'success',
        resultText: sentMessageResult(environment.host, delivered.messageId),
        durationMs: BigInt(Math.round(performance.now() - startedAt)),
        finishedAt: now,
      })
      .where(eq(toolCalls.id, toolId))
      .run();
    // A virtual host wrote this row in the same transaction that published
    // the message; overwriting it here would drop the link it recorded and
    // could not add the Telegram metadata a room never had.
    if (recordedByHost) {
      return;
    }
    environment.store.orm
      .update(hostSends)
      .set({
        state: 'success',
        telegramMessageId: delivered.messageId,
        responseJson: JSON.stringify({ message_id: Number(delivered.messageId) }),
        finishedAt: now,
      })
      .where(eq(hostSends.id, sendId))
      .run();
  };
  try {
    environment.store.transaction(() => {
      markAccepted();
      if (recordedByHost) {
        // The host already published the message it reported; mirroring it
        // again would leave a second, contradicting copy in the store.
        return;
      }
      recordOutgoingMessage(
        environment,
        delivered,
        send,
        stickerFileId ?? null,
        targetConversationId,
        composedText,
        now,
      );
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'send_record_failed',
        invocation_id: environment.context.invocationId.toString(),
        telegram_message_id: String(delivered.messageId),
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }),
    );
    // Keep at least the accepted outcome when only the outgoing-message
    // record failed; if the store itself is failing, the log is the record.
    try {
      markAccepted();
    } catch {}
  }
  return {
    content: [
      {
        type: 'text',
        text: reportsWireIds(environment.host)
          ? `Sent Telegram message ${delivered.messageId}`
          : `Sent message ${delivered.messageId}`,
      },
    ],
    details: sentDetails(environment.host, String(delivered.messageId)),
  };
}
