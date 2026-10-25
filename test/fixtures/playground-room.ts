/**
 * Seeds one Playground room with a frozen invocation, for context tests.
 *
 * It writes the same rows the room ingestion path writes, so the context
 * builder sees a real room: a playground chat, its conversation, member
 * senders, messages with room sequence numbers, and an invocation whose
 * snapshots use the room format.
 */
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';

import {
  buckets,
  chats,
  conversations,
  invocationMessages,
  invocations,
  messages,
  messageRevisions,
  roomParticipants,
  rooms,
  senders,
} from '../../src/store/schema/index.ts';
import { ROOM_SNAPSHOT_FORMAT } from '../../src/context/builder/schema.ts';

export interface SeededRoomMessage {
  readonly seq: number;
  readonly text: string;
  readonly sender: number;
  readonly sentByBot?: boolean;
}

export interface SeededPlaygroundRoom {
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly invocationId: bigint;
  readonly bucketId: bigint;
  readonly senderIds: readonly bigint[];
  readonly messageIds: readonly bigint[];
}

const STAMP = '2026-10-17T10:00:00.000Z';

export function seedPlaygroundRoom(
  store: SqliteStore,
  options: { readonly messages?: readonly SeededRoomMessage[] } = {},
): SeededPlaygroundRoom {
  const seeded = options.messages ?? [
    { seq: 11, text: 'first room message', sender: 0 },
    { seq: 12, text: 'second room message', sender: 1 },
  ];
  const chat = store.orm
    .insert(chats)
    .values({
      hostKind: 'playground',
      type: 'group',
      title: 'Playground Room',
      telegramChatId: null,
      canonicalChatId: null,
      updatedAt: STAMP,
    })
    .returning({ id: chats.id })
    .get();
  if (chat === undefined) {
    throw new Error('failed to seed room chat');
  }
  store.orm
    .insert(rooms)
    .values({
      chatId: chat.id,
      revision: 1n,
      nextSeq: 13n,
      createdAt: STAMP,
      updatedAt: STAMP,
    })
    .run();
  const conversation = store.orm
    .insert(conversations)
    .values({ chatId: chat.id, messageThreadId: 0n, createdAt: STAMP, updatedAt: STAMP })
    .returning({ id: conversations.id })
    .get();
  if (conversation === undefined) {
    throw new Error('failed to seed room conversation');
  }

  const senderIds: bigint[] = [];
  for (const [index, name] of ['Alice', 'Bob'].entries()) {
    const sender = store.orm
      .insert(senders)
      .values({
        hostKind: 'playground',
        telegramId: null,
        telegramType: null,
        displayName: name,
        username: null,
        isBot: false,
        updatedAt: STAMP,
      })
      .returning({ id: senders.id })
      .get();
    if (sender === undefined) {
      throw new Error('failed to seed room sender');
    }
    senderIds.push(sender.id);
    store.orm
      .insert(roomParticipants)
      .values({
        chatId: chat.id,
        senderId: sender.id,
        role: index === 0 ? 'admin' : 'member',
        joinedAt: STAMP,
      })
      .run();
  }

  const bucket = store.orm
    .insert(buckets)
    .values({
      conversationId: conversation.id,
      state: 'running',
      kind: 'realtime',
      firstReceivedAt: STAMP,
      deadlineAt: STAMP,
      startedAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
    })
    .returning({ id: buckets.id })
    .get();
  if (bucket === undefined) {
    throw new Error('failed to seed room bucket');
  }
  const invocation = store.orm
    .insert(invocations)
    .values({
      bucketId: bucket.id,
      conversationId: conversation.id,
      state: 'running',
      configHash: 'room-config',
      promptVersion: 1n,
      startedAt: STAMP,
      createdAt: STAMP,
    })
    .returning({ id: invocations.id })
    .get();
  if (invocation === undefined) {
    throw new Error('failed to seed room invocation');
  }

  const messageIds: bigint[] = [];
  for (const [index, entry] of seeded.entries()) {
    const senderId = senderIds[entry.sender];
    if (senderId === undefined) {
      throw new Error(`unknown sender index ${entry.sender}`);
    }
    const senderName = entry.sender === 0 ? 'Alice' : 'Bob';
    const message = store.orm
      .insert(messages)
      .values({
        chatId: chat.id,
        conversationId: conversation.id,
        hostKind: 'playground',
        telegramMessageId: null,
        telegramDate: STAMP,
        receivedAt: STAMP,
        localSequenceNo: BigInt(entry.seq),
      })
      .returning({ id: messages.id })
      .get();
    if (message === undefined) {
      throw new Error('failed to seed room message');
    }
    messageIds.push(message.id);
    const revision = store.orm
      .insert(messageRevisions)
      .values({
        messageId: message.id,
        revisionNo: 1n,
        kind: 'text',
        text: entry.text,
        caption: null,
        senderId,
        createdAt: STAMP,
        rawFragmentJson: '{}',
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('failed to seed room revision');
    }
    store.orm
      .insert(invocationMessages)
      .values({
        invocationId: invocation.id,
        sourceBucketId: bucket.id,
        sequenceNo: BigInt(index + 1),
        messageId: message.id,
        revisionId: revision.id,
        section: 'new',
        snapshotJson: JSON.stringify({
          host: 'playground',
          message_id: String(entry.seq),
          sent_at: STAMP,
          sent_by_bot: entry.sentByBot ?? false,
          revision: '1',
          sender: { ref: `member_${entry.sender + 1}`, name: senderName, role: 'member' },
          kind: 'text',
          text: entry.text,
          caption: null,
          reply_to_message_id: null,
          reply_snapshot: null,
          media: [],
        }),
        snapshotFormat: ROOM_SNAPSHOT_FORMAT,
      })
      .run();
  }

  return {
    chatId: chat.id,
    conversationId: conversation.id,
    invocationId: invocation.id,
    bucketId: bucket.id,
    senderIds,
    messageIds,
  };
}
