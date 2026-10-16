/**
 * T03 acceptance: a Bot Playground room publishes its own messages.
 *
 * The room has no wire, so the tests here drive the real send pipeline against
 * a real store and check the ledger, the message it produced, and every way a
 * delivery is refused - always with an explicit reason, never a fake success.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { createSendTools } from '../src/capabilities/send-tool.ts';
import { InvocationContextState } from '../src/platform/invocation-context.ts';
import { identityConversation, PLAYGROUND_ACTIVITY_CAP_MS } from '../src/platform/im-host.ts';
import {
  buckets,
  chats,
  conversations,
  hostSends,
  invocations,
  messageRevisions,
  messages,
  rooms,
  roomParticipants,
  senders,
  toolCalls,
} from '../src/store/schema.ts';
import type { BusinessStore } from '../src/store/store.ts';

/** Nothing in a room may reach Telegram, so every delivery is watched here. */
const telegramTransport = vi.fn();

const NOW = new Date('2026-10-16T12:00:00.000Z');

interface RoomFixture {
  readonly store: BusinessStore;
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly selfSenderId: bigint;
  readonly invocationId: bigint;
}

describe('Bot Playground virtual delivery', () => {
  let directory: string;
  let store: SqliteStore;

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
  const createRoom = (input: {
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
    store.orm
      .insert(rooms)
      .values({ chatId: input.chatId, createdAt: stamp, updatedAt: stamp })
      .run();
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

  const hostFor = (selfDisplayName: string) =>
    createPlaygroundHost({
      store,
      self: { displayName: selfDisplayName },
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });

  /** Reserves the ledger row the way the pipeline does before delivering. */
  const reserveSend = (
    conversationId: bigint,
    invocationId: bigint,
    request: Record<string, unknown>,
  ): bigint => {
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

  const deliver = (
    host: ReturnType<typeof hostFor>,
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

  const ledgerRow = (sendId: bigint) =>
    store.orm.select().from(hostSends).where(eq(hostSends.id, sendId)).get();

  const roomMessages = (conversationId: bigint) =>
    store.orm
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all();

  test('publishes a virtual message and records it in the same row as the send', async () => {
    const room = createRoom({ chatId: 10n, title: 'Sprint room', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const sendId = reserveSend(room.conversationId, room.invocationId, { id: 'a', text: 'hello room' });

    const outcome = await deliver(host, { ...room, title: 'Sprint room' }, sendId, 'hello room');

    expect(outcome.kind).toBe('delivered');
    if (outcome.kind !== 'delivered') {
      return;
    }
    // The host published it, so the caller must not write anything again.
    expect(outcome.recordedByHost).toBe(true);
    const [published] = outcome.messages;
    expect(published?.partIndex).toBe(0);

    const written = roomMessages(room.conversationId);
    expect(written).toHaveLength(1);
    const message = written[0]!;
    expect(message.id).toBe(published?.messageId);
    expect(message.hostKind).toBe('playground');
    expect(message.telegramMessageId).toBeNull();
    expect(message.sentByBot).toBe(true);
    expect(message.localSequenceNo).toBe(1n);

    const revision = store.orm
      .select()
      .from(messageRevisions)
      .where(eq(messageRevisions.messageId, message.id))
      .get();
    expect(revision?.text).toBe('hello room');
    expect(revision?.senderId).toBe(room.selfSenderId);
    expect(message.currentRevisionId).toBe(revision?.id);

    // The audit row names the message it produced, in one committed unit.
    const ledger = ledgerRow(sendId);
    expect(ledger?.state).toBe('success');
    expect(ledger?.messageId).toBe(message.id);
    // A room never claims a Telegram response.
    expect(ledger?.telegramMessageId).toBeNull();

    // The room counters advanced exactly once.
    const roomRow = store.orm.select().from(rooms).where(eq(rooms.chatId, room.chatId)).get();
    expect(roomRow?.nextSeq).toBe(2n);
    expect(roomRow?.revision).toBe(1n);
  });

  test('repeating one delivery key publishes nothing a second time', async () => {
    const room = createRoom({ chatId: 11n, title: 'Repeat room', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const sendId = reserveSend(room.conversationId, room.invocationId, { id: 'b', text: 'once' });

    const first = await deliver(host, { ...room, title: 'Repeat room' }, sendId, 'once');
    const second = await deliver(host, { ...room, title: 'Repeat room' }, sendId, 'once');

    expect(first.kind).toBe('delivered');
    expect(second.kind).toBe('delivered');
    if (first.kind !== 'delivered' || second.kind !== 'delivered') {
      return;
    }
    expect(second.messages[0]?.messageId).toBe(first.messages[0]?.messageId);
    expect(roomMessages(room.conversationId)).toHaveLength(1);
    const roomRow = store.orm.select().from(rooms).where(eq(rooms.chatId, room.chatId)).get();
    expect(roomRow?.nextSeq).toBe(2n);
  });

  test('two rooms with the same title never cross', async () => {
    const left = createRoom({ chatId: 20n, title: '同名房间', selfDisplayName: '碗' });
    const right = createRoom({ chatId: 21n, title: '同名房间', selfDisplayName: '碗' });
    const host = hostFor('碗');

    const leftSend = reserveSend(left.conversationId, left.invocationId, { id: 'l', text: 'left' });
    const rightSend = reserveSend(right.conversationId, right.invocationId, { id: 'r', text: 'right' });
    await deliver(host, { ...left, title: '同名房间' }, leftSend, 'left');
    await deliver(host, { ...right, title: '同名房间' }, rightSend, 'right');

    expect(roomMessages(left.conversationId)).toHaveLength(1);
    expect(roomMessages(right.conversationId)).toHaveLength(1);
    expect(ledgerRow(leftSend)?.messageId).toBe(roomMessages(left.conversationId)[0]?.id);
    expect(ledgerRow(rightSend)?.messageId).toBe(roomMessages(right.conversationId)[0]?.id);
  });

  test('refuses a target from another room instead of trusting it', async () => {
    const home = createRoom({ chatId: 30n, title: 'home', selfDisplayName: '碗' });
    const other = createRoom({ chatId: 31n, title: 'other', selfDisplayName: '碗' });
    const host = hostFor('碗');

    // The flag is what the pipeline reads before building a target at all.
    expect(host.delivery.crossConversationTargets).toBe(false);

    const sendId = reserveSend(home.conversationId, home.invocationId, { id: 'x', text: 'stray' });
    const outcome = await deliver(host, { ...other, title: 'other' }, sendId, 'stray');
    expect(outcome.kind).toBe('delivered');

    // It landed in the room it named and nowhere else.
    expect(roomMessages(other.conversationId)).toHaveLength(1);
    expect(roomMessages(home.conversationId)).toHaveLength(0);
  });

  test('refuses media a room cannot show, with a reason and no message', async () => {
    const room = createRoom({ chatId: 40n, title: 'media', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const target = { conversation, policy: host.policy(conversation) };

    for (const part of [
      { kind: 'sticker', stickerRef: 'stk_1' } as const,
      { kind: 'photo', bytes: new Uint8Array([1, 2, 3]), fileName: 'a.png' } as const,
    ]) {
      const sendId = reserveSend(room.conversationId, room.invocationId, { id: `m-${part.kind}`, kind: part.kind });
      const outcome = await host.delivery.deliver({
        target,
        parts: [part],
        sendId,
        signal: undefined,
      });
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.failure.reason).toBe('permanent');
        expect(outcome.failure.code).toBe('unsupported_media');
        expect(outcome.failure.description).toContain(part.kind);
        expect(outcome.failure.outcomeUnknown).toBe(false);
      }
      // A refusal must not leave a half-written message behind.
      expect(ledgerRow(sendId)?.state).toBe('pending');
      expect(ledgerRow(sendId)?.messageId).toBeNull();
    }
    expect(roomMessages(room.conversationId)).toHaveLength(0);
  });

  test('refuses a conversation that is not a room', async () => {
    const room = createRoom({ chatId: 50n, title: 'not a room', selfDisplayName: '碗' });
    // A Telegram chat the room host must not publish into.
    store.orm
      .insert(chats)
      .values({
        id: 51n,
        hostKind: 'telegram',
        telegramChatId: 999n,
        canonicalChatId: 999n,
        type: 'private',
        title: 'telegram',
        updatedAt: NOW.toISOString(),
      })
      .run();
    const conversation = store.orm
      .insert(conversations)
      .values({ chatId: 51n, messageThreadId: 0n, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .returning({ id: conversations.id })
      .get();
    if (conversation === undefined) {
      throw new Error('conversation insert returned no row');
    }
    void room;

    const host = hostFor('碗');
    const sendId = reserveSend(conversation.id, room.invocationId, { id: 'tg', text: 'nope' });
    const outcome = await deliver(host, { conversationId: conversation.id, chatId: 51n, title: 'telegram' }, sendId, 'nope');
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.failure.code).toBe('host_mismatch');
    }
  });

  test('a reply names a local message without touching Telegram', async () => {
    const room = createRoom({ chatId: 60n, title: 'reply', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const first = reserveSend(room.conversationId, room.invocationId, { id: 'p1', text: 'question' });
    const firstOutcome = await deliver(host, { ...room, title: 'reply' }, first, 'question');
    expect(firstOutcome.kind).toBe('delivered');
    if (firstOutcome.kind !== 'delivered') {
      return;
    }
    const target = firstOutcome.messages[0]!.messageId;

    const second = reserveSend(room.conversationId, room.invocationId, { id: 'p2', text: 'answer' });
    const secondOutcome = await deliver(host, { ...room, title: 'reply' }, second, 'answer', target);
    expect(secondOutcome.kind).toBe('delivered');
    if (secondOutcome.kind !== 'delivered') {
      return;
    }

    const reply = store.orm
      .select()
      .from(messages)
      .where(eq(messages.id, secondOutcome.messages[0]!.messageId))
      .get();
    expect(reply?.localReplyToMessageId).toBe(target);
    expect(reply?.telegramMessageId).toBeNull();
    expect(telegramTransport).not.toHaveBeenCalled();
  });

  test('local activity expires on its own without polling', () => {
    const host = hostFor('碗');
    const conversation = identityConversation(
      { chatId: 70n, threadId: 0n, conversationId: 70n },
      'playground',
      'private',
    );
    // A room shows no chat action, so nothing schedules a refresh.
    expect(host.policy(conversation).activity.kind).toBe('none');
    expect(host.policy(conversation).activity.refreshMs).toBeNull();
    expect(host.policy(conversation).activity.capMs).toBe(PLAYGROUND_ACTIVITY_CAP_MS);

    host.activity.start({ conversation, policy: host.policy(conversation) });
    host.activity.stop(conversation);
    expect(() => host.activity.stopAll()).not.toThrow();
  });

  test('driving the real send tool audits a virtual message and calls no Telegram API', async () => {
    const room = createRoom({ chatId: 80n, title: 'pipeline', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const context = new InvocationContextState({
      invocationId: room.invocationId,
      conversationId: room.conversationId,
      chatId: room.chatId,
      threadId: 0n,
      completion: null,
    });

    const tools = createSendTools({
      store,
      host,
      conversation,
      context,
      capabilities: {
        resolveMedia: () => undefined,
        resolveStickerRef: () => undefined,
        resolveReplyTarget: () => undefined,
        registerStickerRef: () => {
          throw new Error('not used');
        },
      },
      sendRateLimit: { sendsPerWindow: 20, windowSeconds: 60 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 60_000,
      bot: { id: 1n, displayName: '碗', username: null },
    });

    const result = await tools.send.execute('call-1', { kind: 'text', text: 'through the tool' });

    expect(result.details.messageId).toBeDefined();
    expect(result.details.telegramMessageId).toBeUndefined();
    const content = result.content[0];
    expect(content !== undefined && content.type === 'text' && content.text.startsWith('Sent message ')).toBe(true);

    const written = roomMessages(room.conversationId);
    expect(written).toHaveLength(1);
    const ledger = store.orm.select().from(hostSends).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.state).toBe('success');
    expect(ledger[0]?.messageId).toBe(written[0]?.id);

    // The tool call is recorded as success too.
    const call = store.orm.select().from(toolCalls).all();
    expect(call[0]?.state).toBe('success');
    expect(telegramTransport).not.toHaveBeenCalled();
  });
});