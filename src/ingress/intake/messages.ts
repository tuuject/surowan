/**
 * The storage half of the neutral intake: sender / conversation / message /
 * revision / media rows plus the `eligibleHuman` decision. All content already
 * arrived normalized on `InboundMessage`; this file only decides whether the
 * delivery drops (own message, unprocessed bot) or stores, and how.
 */
import { and, eq, sql } from 'drizzle-orm';
import { hostIntakeSettings } from '../../platform/config/index.ts';
import {
  chats,
  conversations,
  media as mediaTable,
  messageRevisions,
  messages,
  senders,
} from '../../store/schema/index.ts';
import type { InboundMessage } from './index.ts';
import type { IntakeDeps } from './buckets.ts';

export interface StoredMessage {
  readonly id: bigint;
  readonly revisionId: bigint;
  readonly conversationId: bigint;
  readonly eligibleHuman: boolean;
  readonly companionOnly: boolean;
}

export function storeInbound(deps: IntakeDeps, message: InboundMessage): StoredMessage | undefined {
  // `chat_id` only proves the chat row exists; its host_kind must agree with
  // the delivery's host, or catch-up scoping (chats) and snapshots (messages)
  // would describe the same row under two different hosts.
  const chat = deps.store.orm
    .select({ hostKind: chats.hostKind })
    .from(chats)
    .where(eq(chats.id, message.internalChatId))
    .get();
  if (chat === undefined || chat.hostKind !== message.host) {
    throw new Error(`inbound chat ${message.internalChatId} is not a '${message.host}' chat`);
  }
  const sender = upsertSender(deps, message);
  // A message sent on behalf of a chat (anonymous group admin, a channel
  // identity, a linked-channel post) carries a placeholder bot account for
  // backward compatibility; its author is the chat identity, recorded as a
  // non-bot.
  const fromBot = message.sender?.type === 'user' && message.sender.isBot;
  const ownMessage = message.fromUserId !== null && message.fromUserId === deps.botId;
  const settings = hostIntakeSettings(deps.configStore.current().config, message.host);
  if (ownMessage || (fromBot && !settings.process_bot_messages)) {
    return undefined;
  }
  const conversationId = upsertConversation(deps, message.internalChatId, message.threadId, message.receivedAt);
  const existing = deps.store.orm
    .all<{ id: bigint; revision_no: bigint }>(
      sql`SELECT m.id, COALESCE(MAX(r.revision_no), 0) AS revision_no FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id WHERE m.chat_id = ${message.internalChatId} AND m.message_no = ${message.messageNo} GROUP BY m.id`,
    )
    .at(0);
  let messageId: bigint;
  let revisionNo: bigint;
  if (existing === undefined) {
    const created = deps.store.orm
      .insert(messages)
      .values({
        conversationId,
        chatId: message.internalChatId,
        hostKind: message.host,
        messageNo: message.messageNo,
        sentAt: message.sentAt.toISOString(),
        receivedAt: message.receivedAt.toISOString(),
      })
      .returning({ id: messages.id })
      .get();
    if (created === undefined) {
      throw new Error('messages insert returned no row');
    }
    messageId = created.id;
    revisionNo = 1n;
  } else {
    messageId = existing.id;
    if (!message.edited) {
      return undefined;
    }
    revisionNo = existing.revision_no + 1n;
  }
  const stickerOnly =
    message.kind === 'sticker' &&
    message.text === null &&
    message.caption === null &&
    message.media.length === 1 &&
    message.media[0]?.kind === 'sticker';
  const eligibleHuman = !fromBot && !message.service && (!stickerOnly || settings.sticker_trigger_enabled === true);
  const revision = deps.store.orm
    .insert(messageRevisions)
    .values({
      messageId,
      revisionNo,
      senderId: sender,
      kind: message.kind,
      text: message.text,
      caption: message.caption,
      replyToMessageId: message.replyToMessageNo,
      replySnapshotJson: message.replySnapshotJson,
      forwardOriginJson: message.forwardOriginJson,
      mediaGroupId: message.mediaGroupId,
      serviceJson: message.service ? message.rawFragmentJson : null,
      createdAt: message.receivedAt.toISOString(),
      rawFragmentJson: message.rawFragmentJson,
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (revision === undefined) {
    throw new Error('message_revisions insert returned no row');
  }
  const revisionId = revision.id;
  deps.store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  for (const item of message.media) {
    deps.store.orm
      .insert(mediaTable)
      .values({
        revisionId,
        kind: item.kind,
        fileId: item.fileId,
        fileUniqueId: item.fileUniqueId,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
        width: item.width,
        height: item.height,
        telegramJson: item.rawJson,
        hostKind: message.host,
      })
      .run();
  }
  return {
    id: messageId,
    revisionId,
    conversationId,
    eligibleHuman,
    companionOnly: !eligibleHuman,
  };
}

function upsertSender(deps: IntakeDeps, message: InboundMessage): bigint | null {
  const sender = message.sender;
  if (sender === null) {
    return null;
  }
  const updatedAt = message.receivedAt.toISOString();
  deps.store.orm
    .insert(senders)
    .values({
      hostKind: message.host,
      hostSenderType: sender.type,
      hostSenderId: sender.id,
      displayName: sender.displayName,
      username: sender.username,
      isBot: sender.isBot,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [senders.hostKind, senders.hostSenderType, senders.hostSenderId],
      set: { displayName: sender.displayName, username: sender.username, isBot: sender.isBot, updatedAt },
    })
    .run();
  const row = deps.store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(
      and(
        eq(senders.hostKind, message.host),
        eq(senders.hostSenderType, sender.type),
        eq(senders.hostSenderId, sender.id),
      ),
    )
    .get();
  if (row === undefined) {
    throw new Error('Sender upsert did not return a row');
  }
  return row.id;
}

function upsertConversation(deps: IntakeDeps, chatId: bigint, threadId: bigint, receivedAt: Date): bigint {
  deps.store.orm
    .insert(conversations)
    .values({
      chatId,
      messageThreadId: threadId,
      createdAt: receivedAt.toISOString(),
      updatedAt: receivedAt.toISOString(),
    })
    .onConflictDoUpdate({
      target: [conversations.chatId, conversations.messageThreadId],
      set: { updatedAt: receivedAt.toISOString() },
    })
    .run();
  const row = deps.store.orm
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
    .get();
  if (row === undefined) {
    throw new Error('Conversation upsert did not return a row');
  }
  return row.id;
}
