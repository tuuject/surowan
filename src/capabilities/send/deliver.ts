/**
 * The first half of one send: narrow and validate the input, apply the
 * duplicate and reply policies, then spend the barrier. The claim that follows
 * lives in send-tool-claim.ts; what this half returns is what the publish half
 * delivers.
 *
 * Split out of send-tool.ts's createSendTools closure. Every check, audit write
 * and its order is unchanged.
 */

import type { Static } from 'typebox';
import {
  sameConversation,
  toConversationId,
  type ImConversationRef,
  type ImDeliveryTarget,
  type ImMentionRequest,
  type ImOutgoingPart,
} from '../../platform/im-host.ts';
import type { InvocationContext } from '../../platform/invocation-context.ts';
import { imageDeliveryState } from '../../store/image-delivery.ts';
import type { SendInputSchema, SendToolInput } from './index.ts';
import { claimSend, rejectDuplicateReply } from './claim.ts';
import { isDuplicateSend, repeatsLastSend, wasRejectedByReplyPolicy } from './guards.ts';
import { recordRejectedSend, recordReplayedSend } from './record.ts';
import {
  completionMention,
  narrowSendInput,
  reportsWireIds,
  SEND_BARRIER_TEXT,
  SEND_BYPASS_TEXT,
  SEND_DUPLICATE_TEXT,
  SEND_REPEAT_TEXT,
  sentDetails,
  type SendDetails,
  type SendToolEnvironment,
} from './support.ts';

/** Everything one claimed send needs to reach the host and be recorded. */
export type PreparedSend = {
  readonly target: ImDeliveryTarget;
  readonly targetConversationId: bigint;
  readonly send: SendToolInput;
  readonly textPart: ImOutgoingPart | undefined;
  readonly stickerFileId: string | undefined;
  readonly generationPictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>;
  readonly composedText: string;
  readonly mention: ImMentionRequest | null;
  readonly completion: InvocationContext['completion'];
  readonly toolId: bigint;
  readonly sendId: bigint;
};

/** A send either finished as a replay, or carries what the host must publish. */
export type PreparedOutcome =
  | { readonly kind: 'replay'; readonly result: { content: { type: 'text'; text: string }[]; details: SendDetails } }
  | { readonly kind: 'ready'; readonly prepared: PreparedSend };

export function prepareSend(
  environment: SendToolEnvironment,
  mentionedTasks: Set<bigint>,
  toolCallId: string,
  input: Static<typeof SendInputSchema>,
  signal: AbortSignal | undefined,
  options: { readonly barrier: boolean },
): PreparedOutcome {
  const { barrier } = options;
  const narrowed = narrowSendInput(input);
  if ('problem' in narrowed) {
    recordRejectedSend(environment, toolCallId, input, 'send_input_invalid');
    throw new Error(`send input does not match its kind: ${narrowed.problem}`);
  }
  const { send } = narrowed;
  const replyTarget =
    send.reply_to_message_id === undefined
      ? undefined
      : environment.capabilities.resolveReplyTarget(send.reply_to_message_id);
  if (send.reply_to_message_id !== undefined && replyTarget === undefined) {
    recordRejectedSend(environment, toolCallId, input, 'reply_not_visible');
    throw new Error('reply_to_message_id is not visible in this conversation context');
  }
  const targetConversationId = replyTarget?.conversationId ?? environment.context.conversationId;
  const targetThreadId = replyTarget?.threadId ?? environment.context.threadId;
  const completion = environment.context.completion;
  const targetConversation: ImConversationRef = {
    ...environment.conversation,
    id: toConversationId(targetConversationId),
    topicId: targetThreadId === 0n ? null : Number(targetThreadId),
  };
  // The host has to be the one this conversation belongs to. A missing or
  // mismatched pair means no host was built for it, and guessing one would
  // publish into a place nobody asked for.
  if (environment.host.host !== environment.conversation.host) {
    recordRejectedSend(environment, toolCallId, input, 'host_not_supported');
    throw new Error(`no "${environment.conversation.host}" host is bound to this conversation`);
  }
  // A reply may address another conversation only where the host allows it:
  // Telegram replies into another topic, a room publishes into itself alone.
  if (
    targetConversationId !== environment.context.conversationId &&
    !sameConversation(targetConversation, environment.conversation) &&
    !environment.host.delivery.crossConversationTargets
  ) {
    recordRejectedSend(environment, toolCallId, input, 'reply_target_other_room');
    throw new Error('reply_to_message_id belongs to another conversation this host cannot reach');
  }
  const target: ImDeliveryTarget = {
    conversation: targetConversation,
    policy: environment.host.policy(targetConversation),
  };
  let mention: ImMentionRequest | null = null;
  if (send.kind === 'text' && completion !== null && !mentionedTasks.has(completion.taskId)) {
    mention = completionMention(completion);
  }
  const textPart: ImOutgoingPart | undefined =
    send.kind === 'text'
      ? {
          kind: 'text',
          text: send.text,
          ...(send.parse_mode !== undefined ? { markup: 'markdown_v2' as const } : {}),
          ...(mention === null ? {} : { mention }),
        }
      : undefined;
  const composedText =
    textPart === undefined
      ? ''
      : (environment.host.delivery.compose(textPart, target.policy.delivery).text ?? textPart.text);
  if (textPart !== undefined) {
    // The host owns mention rendering, so the size and shape checks must look
    // at what it will actually put on the wire, prefix included.
    if (environment.maxTextLength !== undefined && composedText.length > environment.maxTextLength) {
      recordRejectedSend(environment, toolCallId, input, 'send_text_too_long');
      throw new Error(
        `text length ${composedText.length} exceeds the configured limit of ${environment.maxTextLength} characters`,
      );
    }
    if (environment.disallowBlankLines && /\n[ \t]*\n/.test(composedText)) {
      recordRejectedSend(environment, toolCallId, input, 'send_blank_lines');
      throw new Error('text must not contain blank lines; separate paragraphs with single newlines');
    }
  }
  const stickerFileId =
    send.kind === 'sticker' ? environment.capabilities.resolveStickerRef(send.sticker_ref) : undefined;
  if (send.kind === 'sticker' && stickerFileId === undefined) {
    recordRejectedSend(environment, toolCallId, input, 'sticker_ref_not_authorized');
    throw new Error('sticker_ref is not authorized in this conversation context');
  }
  let resolvedPictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>;
  try {
    resolvedPictures =
      send.kind === 'image'
        ? environment.imageGeneration?.resolve(send.image_generation_id, environment.context.conversationId)
        : undefined;
  } catch {
    recordRejectedSend(environment, toolCallId, input, 'image_generation_unavailable');
    throw new Error('image_generation_unavailable: generated output files could not be read');
  }
  let generationPictures = send.kind === 'image' ? (resolvedPictures === undefined ? [] : resolvedPictures) : undefined;
  if (send.kind === 'image' && resolvedPictures === undefined) {
    recordRejectedSend(environment, toolCallId, input, 'image_generation_not_authorized');
    throw new Error(
      'image_generation_id does not name a finished generation of this conversation; use ids from tool results or receipts here',
    );
  }
  if (send.kind === 'image' && (generationPictures?.length ?? 0) === 0) {
    recordRejectedSend(environment, toolCallId, input, 'image_generation_no_outputs');
    throw new Error('that generation produced no pictures to send');
  }
  if (send.kind === 'image' && (send.text?.length ?? 0) > 1024) {
    recordRejectedSend(environment, toolCallId, input, 'send_caption_too_long');
    throw new Error('image caption must not exceed 1024 characters');
  }
  // A cancelled or expired run must not start a side effect: the model may
  // have queued this call before the abort or deadline landed.
  if (signal?.aborted === true || Date.now() >= environment.deadline) {
    const errorCode = signal?.aborted === true ? 'aborted' : 'deadline_exceeded';
    recordRejectedSend(environment, toolCallId, input, errorCode);
    throw new Error(`Not sent: ${errorCode}`);
  }
  if (send.kind === 'image' && generationPictures !== undefined) {
    if (send.resend === true && (completion !== null || environment.context.callerUserId === null)) {
      recordRejectedSend(environment, toolCallId, input, 'image_resend_requires_user');
      throw new Error('resend:true requires an explicit new user request, not a completion receipt');
    }
    const delivery = imageDeliveryState(environment.store.orm, targetConversationId, send.image_generation_id);
    // A prior uncertain attempt is not permission to try again, even when a
    // model asks for a resend. The user must resolve that outcome first.
    if (delivery.unknownAssets || generationPictures.some((picture) => delivery.uncertain.has(picture.assetId))) {
      recordRejectedSend(environment, toolCallId, input, 'image_delivery_unknown');
      throw new Error('An earlier image delivery is pending or has an unknown outcome; do not resend blindly');
    }
    if (send.resend !== true) {
      const messageIds = [
        ...new Set(
          generationPictures.flatMap((picture) => {
            const messageId = delivery.delivered.get(picture.assetId);
            return messageId === undefined ? [] : [messageId];
          }),
        ),
      ];
      const firstMessageId = messageIds[0];
      generationPictures = generationPictures.filter((picture) => !delivery.delivered.has(picture.assetId));
      if (generationPictures.length === 0 && firstMessageId !== undefined) {
        const text = reportsWireIds(environment.host)
          ? `Images already delivered; Telegram delivery message(s): ${messageIds.join(', ')}. No new message was sent.`
          : `Images already delivered; message(s): ${messageIds.join(', ')}. No new message was sent.`;
        recordReplayedSend(environment, toolCallId, send, text);
        return {
          kind: 'replay',
          result: {
            content: [{ type: 'text', text }],
            details: sentDetails(environment.host, firstMessageId, true),
          },
        };
      }
    }
  }
  // Tools run sequentially within one invocation, so this check needs no
  // transaction: no other send of the same run can land in between.
  if (isDuplicateSend(environment, send)) {
    recordRejectedSend(environment, toolCallId, input, 'send_duplicate');
    environment.duplicateSendGuard?.onRejected();
    throw new Error(SEND_DUPLICATE_TEXT);
  }
  // The reply policy's "do not bypass a rejection by omitting or changing
  // reply_to_message_id" is enforced: rejected content stays unsendable for
  // the rest of this run, whichever target the retry aims at.
  if (wasRejectedByReplyPolicy(environment, send)) {
    recordRejectedSend(environment, toolCallId, input, 'send_bypass');
    environment.duplicateSendGuard?.onRejected();
    throw new Error(SEND_BYPASS_TEXT);
  }
  if (repeatsLastSend(environment, send)) {
    recordRejectedSend(environment, toolCallId, input, 'send_duplicate');
    environment.duplicateSendGuard?.onRejected();
    throw new Error(SEND_REPEAT_TEXT);
  }
  // Reject known duplicates before spending the barrier. The barrier commits
  // bucket attachments before queueing them in memory, so it must run outside
  // the send transaction: a later audit failure must not undo those attachments.
  const duplicate = rejectDuplicateReply(environment, toolCallId, input, send, targetConversationId);
  if (duplicate !== undefined) {
    throw new Error(duplicate.error);
  }
  if (barrier && environment.holdForNewMessages?.() === true) {
    recordRejectedSend(environment, toolCallId, input, 'send_barrier');
    throw new Error(SEND_BARRIER_TEXT);
  }
  const pending = claimSend(environment, toolCallId, input, send, targetConversationId, generationPictures);
  if ('error' in pending) {
    throw new Error(pending.error);
  }
  return {
    kind: 'ready',
    prepared: {
      target,
      targetConversationId,
      send,
      textPart,
      stickerFileId,
      generationPictures,
      composedText,
      mention,
      completion,
      toolId: pending.toolId,
      sendId: pending.sendId,
    },
  };
}
