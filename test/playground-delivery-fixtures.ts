/**
 * Shared room fixtures for the `Bot Playground virtual delivery` suites.
 *
 * A room has no wire, so the suites drive the real send pipeline against a real
 * store and check the ledger, the message it produced, and every way a delivery
 * is refused - always with an explicit reason, never a fake success.
 *
 * This is not a test file: importing it registers the per-test store hooks (one
 * fresh store and temp directory per test, a cleared Telegram spy) and the
 * `store`/`directory` bindings the suites read stay live across those hooks.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { identityConversation, type ImHost } from '../src/platform/im-host.ts';
import {
  buckets,
  chats,
  conversations,
  hostSends,
  invocations,
  messages,
  rooms,
  roomParticipants,
  senders,
  toolCalls,
} from '../src/store/schema.ts';
import type { BusinessStore } from '../src/store/store.ts';

/** Nothing in a room may reach Telegram, so every delivery is watched here. */
export const telegramTransport = vi.fn();

export const NOW = new Date('2026-10-16T12:00:00.000Z');

export interface RoomFixture {
  readonly store: BusinessStore;
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly selfSenderId: bigint;
  readonly invocationId: bigint;
}

/** Assigned by the hooks below and read by the importing suite. */
export let directory: string;
export let store: SqliteStore;

beforeEach(async () => {
  telegramTransport.mockClear();
  directory = await mkdtemp(join(tmpdir(), 'surowan-playground-'));
  store = await SqliteStore.open({
    paths: { database: join(directory, 'surowan.sqlite'), data: directory },
  } as never);
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

/**
 * A room is a chat with no Telegram ids plus its own counters. Two rooms may
 * carry the same title, so everything here keys on the chat row.
 */
export const createRoom = (input: {
  readonly chatId: bigint;
  readonly title: string;
  readonly selfDisplayName: string;
}): RoomFixture => {
  const stamp = NOW.toISOString();
  store.orm
    .insert(chats)
    .values({
      id: input.chatId,
      hostKind: 'playground',
      telegramChatId: null,
      canonicalChatId: null,
      // A room is a virtual chat: no Telegram ids, and the documented type.
      type: 'virtual',
      title: input.title,
      updatedAt: stamp,
    })
    .run();
  store.orm.insert(rooms).values({ chatId: input.chatId, createdAt: stamp, updatedAt: stamp }).run();
  const self = store.orm
    .insert(senders)
    .values({
      hostKind: 'playground',
      displayName: input.selfDisplayName,
      username: null,
      isBot: true,
      updatedAt: stamp,
    })
    .returning({ id: senders.id })
    .get();
  const conversation = store.orm
    .insert(conversations)
    .values({ chatId: input.chatId, messageThreadId: 0n, createdAt: stamp, updatedAt: stamp })
    .returning({ id: conversations.id })
    .get();
  if (self === undefined || conversation === undefined) {
    throw new Error('room setup returned no row');
  }
  store.orm
    .insert(roomParticipants)
    .values({ chatId: input.chatId, senderId: self.id, role: 'admin', joinedAt: stamp })
    .run();
  // A ledger row is a child of an invocation, so every room gets the run the
  // sends below are attributed to.
  const bucket = store.orm
    .insert(buckets)
    .values({
      conversationId: conversation.id,
      state: 'completed',
      firstReceivedAt: stamp,
      deadlineAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({ id: buckets.id })
    .get();
  if (bucket === undefined) {
    throw new Error('buckets insert returned no row');
  }
  const invocation = store.orm
    .insert(invocations)
    .values({
      bucketId: bucket.id,
      conversationId: conversation.id,
      state: 'running',
      configHash: 'hash',
      promptVersion: 1n,
      createdAt: stamp,
    })
    .returning({ id: invocations.id })
    .get();
  if (invocation === undefined) {
    throw new Error('invocations insert returned no row');
  }
  return {
    store,
    chatId: input.chatId,
    conversationId: conversation.id,
    selfSenderId: self.id,
    invocationId: invocation.id,
  };
};

export const hostFor = (selfDisplayName: string) =>
  createPlaygroundHost({
    store,
    self: { displayName: selfDisplayName },
    sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
    now: () => NOW,
  });

/** Reserves the ledger row the way the pipeline does before delivering. */
export const reserveSend = (conversationId: bigint, invocationId: bigint, request: Record<string, unknown>): bigint => {
  const stamp = NOW.toISOString();
  const toolCall = store.orm
    .insert(toolCalls)
    .values({
      invocationId,
      toolCallId: `call-${String(request.id ?? 'x')}`,
      toolName: 'send',
      argumentsJson: '{}',
      state: 'pending',
      sideEffect: true,
      createdAt: stamp,
    })
    .returning({ id: toolCalls.id })
    .get();
  if (toolCall === undefined) {
    throw new Error('tool_calls insert returned no row');
  }
  const send = store.orm
    .insert(hostSends)
    .values({
      toolCallId: toolCall.id,
      conversationId,
      kind: 'text',
      requestJson: JSON.stringify(request),
      state: 'pending',
      createdAt: stamp,
    })
    .returning({ id: hostSends.id })
    .get();
  if (send === undefined) {
    throw new Error('host_sends insert returned no row');
  }
  return send.id;
};

export const deliver = (
  host: ImHost,
  target: { conversationId: bigint; chatId: bigint; title: string },
  sendId: bigint,
  text: string,
  replyToMessageId?: bigint,
) => {
  const conversation = identityConversation(
    { chatId: target.chatId, threadId: 0n, conversationId: target.conversationId },
    'playground',
    'private',
  );
  return host.delivery.deliver({
    target: { conversation, policy: host.policy(conversation) },
    parts: [{ kind: 'text', text }],
    sendId,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    signal: undefined,
  });
};

export const ledgerRow = (sendId: bigint) => store.orm.select().from(hostSends).where(eq(hostSends.id, sendId)).get();

export const roomMessages = (conversationId: bigint) =>
  store.orm.select().from(messages).where(eq(messages.conversationId, conversationId)).all();
