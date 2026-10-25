/**
 * The audit rows a send writes: rejections that never reached the host, the
 * failed or uncertain attempt it claimed, a replayed delivery, and the outgoing
 * message a successful send leaves behind.
 *
 * Split out of send-tool.ts; every statement and its order is unchanged.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { ImDeliveredMessage } from '../../platform/im-host/delivery.ts';
import {
  chats,
  media,
  messageRevisions,
  messages,
  senders,
  stickers,
  hostSends,
  toolCalls,
} from '../../store/schema/index.ts';
import { rejectToolCall } from '../../store/store.ts';
import type { SendToolInput } from './index.ts';
import type { SendToolEnvironment } from './support.ts';

export function recordRejectedSend(
  environment: SendToolEnvironment,
  toolCallId: string,
  input: unknown,
  errorCode: string,
  toolName: 'send' | 'send_reply' = 'send',
): void {
  rejectToolCall(
    environment.store.orm,
    environment.context.invocationId,
    toolCallId,
    toolName,
    JSON.stringify(input),
    true,
    errorCode,
  );
}

export function recordOutgoingMessage(
  environment: SendToolEnvironment,
  delivered: ImDeliveredMessage,
  input: SendToolInput,
  stickerFileId: string | null,
  conversationId: bigint,
  sentText: string,
  recordedAt: string,
): void {
  environment.store.orm
    .insert(senders)
    .values({
      telegramType: 'user',
      telegramId: environment.bot.id,
      displayName: environment.bot.displayName,
      username: environment.bot.username,
      isBot: true,
      updatedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: [senders.telegramType, senders.telegramId],
      set: {
        displayName: sql`excluded.display_name`,
        username: sql`excluded.username`,
        isBot: true,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();
  const sender = environment.store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(and(eq(senders.telegramType, 'user'), eq(senders.telegramId, environment.bot.id)))
    .get();
  if (sender === undefined) {
    throw new Error('Bot sender row is missing after upsert');
  }
  const chat = environment.store.orm
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.telegramChatId, environment.context.chatId))
    .get();
  if (chat === undefined) {
    throw new Error('Outgoing chat row does not exist');
  }
  const createdMessage = environment.store.orm
    .insert(messages)
    .values({
      conversationId,
      chatId: chat.id,
      telegramMessageId: delivered.messageId,
      visible: true,
      sentByBot: true,
      telegramDate: new Date(delivered.sentAtSeconds * 1000).toISOString(),
      receivedAt: recordedAt,
    })
    .returning({ id: messages.id })
    .get();
  if (createdMessage === undefined) {
    throw new Error('messages insert returned no row');
  }
  const messageId = createdMessage.id;
  const createdRevision = environment.store.orm
    .insert(messageRevisions)
    .values({
      messageId,
      revisionNo: 1n,
      senderId: sender.id,
      kind: input.kind,
      text: input.kind === 'text' ? sentText : null,
      caption: input.kind === 'image' ? (input.text ?? null) : null,
      replyToMessageId: input.reply_to_message_id === undefined ? null : BigInt(input.reply_to_message_id),
      createdAt: recordedAt,
      rawFragmentJson: JSON.stringify({
        message_id: Number(delivered.messageId),
        kind: input.kind,
        ...(input.kind === 'image' ? { generation_id: input.image_generation_id } : {}),
      }),
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (createdRevision === undefined) {
    throw new Error('message_revisions insert returned no row');
  }
  const revisionId = createdRevision.id;
  environment.store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  const sentPhoto = delivered.photo;
  if (input.kind === 'image' && sentPhoto !== undefined) {
    environment.store.orm
      .insert(media)
      .values({
        revisionId,
        kind: 'photo',
        fileId: sentPhoto.fileRef,
        fileUniqueId: sentPhoto.fileUniqueRef,
        mimeType: 'image/jpeg',
        width: BigInt(sentPhoto.width),
        height: BigInt(sentPhoto.height),
        telegramJson: JSON.stringify({ sent: true, generated: true }),
      })
      .run();
  }
  if (input.kind === 'sticker' && stickerFileId !== null) {
    const sticker = environment.store.orm
      .select({ fileUniqueId: stickers.fileUniqueId })
      .from(stickers)
      .where(eq(stickers.fileId, stickerFileId))
      .get();
    if (sticker !== undefined) {
      environment.store.orm
        .insert(media)
        .values({
          revisionId,
          kind: 'sticker',
          fileId: stickerFileId,
          fileUniqueId: sticker.fileUniqueId,
          mimeType: 'image/webp',
          telegramJson: JSON.stringify({ sent: true }),
        })
        .run();
    }
  }
}

/**
 * The audit row for a send that replayed an earlier delivery: the message was
 * accepted before, so nothing went out and nothing is claimed as a side effect.
 */
export function recordReplayedSend(
  environment: SendToolEnvironment,
  toolCallId: string,
  send: SendToolInput,
  text: string,
): void {
  const now = new Date().toISOString();
  environment.store.orm
    .insert(toolCalls)
    .values({
      invocationId: environment.context.invocationId,
      toolCallId,
      toolName: 'send',
      argumentsJson: JSON.stringify(send),
      state: 'success',
      sideEffect: false,
      resultText: text,
      createdAt: now,
      finishedAt: now,
    })
    .run();
}

/** Records a failed or uncertain delivery against the rows the claim wrote. */
export function markSendFailed(
  environment: SendToolEnvironment,
  failed: {
    readonly toolId: bigint;
    readonly sendId: bigint;
    readonly errorCode: string;
    readonly unknown: boolean;
    readonly reason: string;
    readonly startedAt: number;
  },
): void {
  environment.store.transaction(() => {
    const now = new Date().toISOString();
    const state = failed.unknown ? 'outcome_unknown' : 'error';
    environment.store.orm
      .update(toolCalls)
      .set({
        state,
        resultText: failed.reason,
        errorCode: failed.errorCode,
        durationMs: BigInt(Math.round(performance.now() - failed.startedAt)),
        finishedAt: now,
      })
      .where(eq(toolCalls.id, failed.toolId))
      .run();
    environment.store.orm
      .update(hostSends)
      .set({ state, errorCode: failed.errorCode, finishedAt: now })
      .where(eq(hostSends.id, failed.sendId))
      .run();
  });
}
