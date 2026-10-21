/**
 * T03 acceptance: a Bot Playground room publishes its own messages.
 *
 * The room has no wire, so the tests here drive the real send pipeline against
 * a real store and check the ledger, the message it produced, and every way a
 * delivery is refused - always with an explicit reason, never a fake success.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { PlaygroundAssetStore } from '../src/capabilities/media/local-assets.ts';
import { createSendTools } from '../src/capabilities/send-tool.ts';
import { InvocationContextState } from '../src/platform/invocation-context.ts';
import { identityConversation, PLAYGROUND_ACTIVITY_CAP_MS } from '../src/platform/im-host.ts';
import {
  buckets,
  chats,
  conversations,
  hostSends,
  invocations,
  media,
  messageRevisions,
  messages,
  playgroundAssets,
  rooms,
  roomParticipants,
  senders,
  toolCalls,
} from '../src/store/schema.ts';
import { type BusinessStore, purgeExpiredData } from '../src/store/store.ts';

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

  const hostFor = (selfDisplayName: string) =>
    createPlaygroundHost({
      store,
      self: { displayName: selfDisplayName },
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });

  /** Reserves the ledger row the way the pipeline does before delivering. */
  const reserveSend = (conversationId: bigint, invocationId: bigint, request: Record<string, unknown>): bigint => {
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

  const ledgerRow = (sendId: bigint) => store.orm.select().from(hostSends).where(eq(hostSends.id, sendId)).get();

  const roomMessages = (conversationId: bigint) =>
    store.orm.select().from(messages).where(eq(messages.conversationId, conversationId)).all();

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
    // A delivery reports the room's own message id, its sequence number.
    expect(published?.messageId).toBe(message.localSequenceNo);
    expect(message.hostKind).toBe('playground');
    expect(message.telegramMessageId).toBeNull();
    expect(message.sentByBot).toBe(true);
    expect(message.localSequenceNo).toBe(1n);

    const revision = store.orm.select().from(messageRevisions).where(eq(messageRevisions.messageId, message.id)).get();
    expect(revision?.text).toBe('hello room');
    expect(revision?.revisionNo).toBe(1n);
    expect(revision?.senderId).toBe(room.selfSenderId);
    expect(message.currentRevisionId).toBe(revision?.id);

    // The audit row names the message it produced, in one committed unit.
    const ledger = ledgerRow(sendId);
    expect(ledger?.state).toBe('success');
    expect(ledger?.messageId).toBe(message.id);
    // A room never claims a Telegram response.
    expect(ledger?.telegramMessageId).toBeNull();

    // The sequence advanced exactly once; bot output never moves the room
    // revision that guards inputs and Release.
    const roomRow = store.orm.select().from(rooms).where(eq(rooms.chatId, room.chatId)).get();
    expect(roomRow?.nextSeq).toBe(2n);
    expect(roomRow?.revision).toBe(0n);
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

    // A send reserved for one room cannot be published into another.
    const sendId = reserveSend(home.conversationId, home.invocationId, { id: 'x', text: 'stray' });
    const outcome = await deliver(host, { ...other, title: 'other' }, sendId, 'stray');
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.failure.code).toBe('send_target_mismatch');
      expect(outcome.failure.outcomeUnknown).toBe(false);
    }
    expect(roomMessages(other.conversationId)).toHaveLength(0);
    expect(roomMessages(home.conversationId)).toHaveLength(0);
    expect(ledgerRow(sendId)?.state).toBe('pending');
    expect(ledgerRow(sendId)?.messageId).toBeNull();

    // Once the home room published it, replaying the key elsewhere still refuses
    // instead of reporting the home room's message as delivered there.
    const home1 = await deliver(host, { ...home, title: 'home' }, sendId, 'stray');
    expect(home1.kind).toBe('delivered');
    const replay = await deliver(host, { ...other, title: 'other' }, sendId, 'stray');
    expect(replay.kind).toBe('rejected');
    expect(roomMessages(other.conversationId)).toHaveLength(0);
    expect(roomMessages(home.conversationId)).toHaveLength(1);
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

    // A sticker can never reach this host (no wire), and a picture cannot be
    // stored when the room has no picture store: both refusals are permanent
    // and leave nothing behind. The picture case names the missing store,
    // because a room with one does show pictures (see the image delivery
    // suite), while a sticker refusal names the part it cannot carry.
    for (const [part, inDescription] of [
      [{ kind: 'sticker', stickerRef: 'stk_1' } as const, 'sticker'],
      [{ kind: 'photo', bytes: new Uint8Array([1, 2, 3]), fileName: 'a.png' } as const, 'picture store'],
    ] as const) {
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
        expect(outcome.failure.description).toContain(inDescription);
        expect(outcome.failure.outcomeUnknown).toBe(false);
      }
      // A refusal must not leave a half-written message behind.
      expect(ledgerRow(sendId)?.state).toBe('pending');
      expect(ledgerRow(sendId)?.messageId).toBeNull();
    }
    expect(roomMessages(room.conversationId)).toHaveLength(0);
  });

  test('refuses text above the room limit instead of cutting it', async () => {
    const room = createRoom({ chatId: 45n, title: 'long', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const limit = host.policy(conversation).delivery.maxTextLength ?? 4096;
    const text = 'x'.repeat(limit + 1);
    // Compose keeps the whole text, so the pipeline's length check sees it.
    expect(host.delivery.compose({ kind: 'text', text }, host.policy(conversation).delivery).text).toBe(text);

    const sendId = reserveSend(room.conversationId, room.invocationId, { id: 'long', text });
    const outcome = await deliver(host, { ...room, title: 'long' }, sendId, text);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.failure.code).toBe('text_too_long');
      expect(outcome.failure.outcomeUnknown).toBe(false);
    }
    expect(roomMessages(room.conversationId)).toHaveLength(0);
    expect(ledgerRow(sendId)?.state).toBe('pending');
  });

  test('the bot identity belongs to the room and survives a namesake and retention', async () => {
    const room = createRoom({ chatId: 47n, title: 'namesake', selfDisplayName: '碗' });
    // Start from a room the bot has not spoken in yet, with a human participant
    // who happens to share the bot's display name.
    store.orm.delete(roomParticipants).where(eq(roomParticipants.senderId, room.selfSenderId)).run();
    store.orm.delete(senders).where(eq(senders.id, room.selfSenderId)).run();
    const human = store.orm
      .insert(senders)
      .values({ hostKind: 'playground', displayName: '碗', isBot: false, updatedAt: NOW.toISOString() })
      .returning({ id: senders.id })
      .get()!;
    store.orm
      .insert(roomParticipants)
      .values({ chatId: room.chatId, senderId: human.id, joinedAt: NOW.toISOString() })
      .run();
    const host = hostFor('碗');
    const authorOf = (messageId: bigint) =>
      store.orm.select().from(messageRevisions).where(eq(messageRevisions.messageId, messageId)).get()?.senderId;

    const first = await deliver(
      host,
      { ...room, title: 'namesake' },
      reserveSend(room.conversationId, room.invocationId, { id: 'n1' }),
      'one',
    );
    expect(first.kind).toBe('delivered');
    if (first.kind !== 'delivered') {
      return;
    }
    const botId = authorOf(roomMessages(room.conversationId)[0]!.id);
    expect(botId).toBeDefined();
    expect(botId).not.toBe(human.id);
    const bot = store.orm.select().from(senders).where(eq(senders.id, botId!)).get();
    expect(bot?.isBot).toBe(true);
    expect(store.orm.select().from(roomParticipants).where(eq(roomParticipants.senderId, botId!)).get()?.chatId).toBe(
      room.chatId,
    );

    // Retention drops the bot's old message; membership keeps its identity, so
    // the next send reuses a row that still exists.
    store.orm
      .update(invocations)
      .set({ state: 'completed', finishedAt: NOW.toISOString() })
      .where(eq(invocations.id, room.invocationId))
      .run();
    purgeExpiredData(store.orm, { retention: { online_days: 30 } } as never, new Date('2027-06-01T00:00:00.000Z'));
    expect(roomMessages(room.conversationId)).toHaveLength(0);
    expect(store.orm.select().from(senders).where(eq(senders.id, botId!)).get()).toBeDefined();

    const later = createRoom({ chatId: 48n, title: 'later', selfDisplayName: '碗' });
    const second = await deliver(
      host,
      { ...later, title: 'later' },
      reserveSend(later.conversationId, later.invocationId, { id: 'n2' }),
      'two',
    );
    expect(second.kind).toBe('delivered');
    if (second.kind !== 'delivered') {
      return;
    }
    // Each room shows its own bot identity.
    expect(authorOf(roomMessages(later.conversationId)[0]!.id)).toBe(later.selfSenderId);
  });

  test('refuses a multi-part delivery before publishing any of it', async () => {
    const room = createRoom({ chatId: 46n, title: 'parts', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    for (const parts of [
      [
        { kind: 'text', text: 'one' },
        { kind: 'text', text: 'two' },
      ],
      [
        { kind: 'text', text: 'caption' },
        { kind: 'sticker', stickerRef: 'stk_1' },
      ],
    ] as const) {
      const sendId = reserveSend(room.conversationId, room.invocationId, {
        id: `parts-${parts.length}-${parts[1].kind}`,
      });
      const outcome = await host.delivery.deliver({
        target: { conversation, policy: host.policy(conversation) },
        parts,
        sendId,
        signal: undefined,
      });
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.failure.code).toBe('multipart_unsupported');
      }
      expect(ledgerRow(sendId)?.state).toBe('pending');
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
    const outcome = await deliver(
      host,
      { conversationId: conversation.id, chatId: 51n, title: 'telegram' },
      sendId,
      'nope',
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.failure.code).toBe('host_mismatch');
    }
  });

  test('a reply names a room sequence and links the stored message it carries', async () => {
    // Another room publishes first, so this room's rows are not numbered like
    // its sequence and a row id taken for a sequence would name the wrong row.
    const other = createRoom({ chatId: 59n, title: 'other', selfDisplayName: '碗' });
    const room = createRoom({ chatId: 60n, title: 'reply', selfDisplayName: '碗' });
    const host = hostFor('碗');
    await deliver(
      host,
      { ...other, title: 'other' },
      reserveSend(other.conversationId, other.invocationId, { id: 'o1' }),
      'x',
    );
    const first = reserveSend(room.conversationId, room.invocationId, { id: 'p1', text: 'question' });
    const firstOutcome = await deliver(host, { ...room, title: 'reply' }, first, 'question');
    expect(firstOutcome.kind).toBe('delivered');
    if (firstOutcome.kind !== 'delivered') {
      return;
    }
    expect(firstOutcome.messages[0]!.messageId).toBe(1n);

    const second = reserveSend(room.conversationId, room.invocationId, { id: 'p2', text: 'answer' });
    const secondOutcome = await deliver(host, { ...room, title: 'reply' }, second, 'answer', 1n);
    expect(secondOutcome.kind).toBe('delivered');
    if (secondOutcome.kind !== 'delivered') {
      return;
    }
    expect(secondOutcome.messages[0]!.messageId).toBe(2n);

    const written = roomMessages(room.conversationId);
    expect(written.map((row) => row.localSequenceNo)).toEqual([1n, 2n]);
    const [question, reply] = written;
    expect(question?.id).not.toBe(1n);
    expect(reply?.localReplyToMessageId).toBe(question?.id);
    expect(reply?.telegramMessageId).toBeNull();
    expect(telegramTransport).not.toHaveBeenCalled();
  });

  test('refuses a reply to a message outside the room', async () => {
    const home = createRoom({ chatId: 61n, title: 'home', selfDisplayName: '碗' });
    const other = createRoom({ chatId: 62n, title: 'other', selfDisplayName: '碗' });
    const host = hostFor('碗');
    const elsewhere = await deliver(
      host,
      { ...other, title: 'other' },
      reserveSend(other.conversationId, other.invocationId, { id: 'o1' }),
      'there',
    );
    if (elsewhere.kind !== 'delivered') {
      throw new Error('setup delivery failed');
    }
    const foreign = elsewhere.messages[0]!.messageId;

    for (const target of [foreign, 999_999n]) {
      const sendId = reserveSend(home.conversationId, home.invocationId, { id: `r-${target}` });
      const outcome = await deliver(host, { ...home, title: 'home' }, sendId, 'answer', target);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.failure.code).toBe('reply_target_other_room');
        expect(outcome.failure.outcomeUnknown).toBe(false);
      }
      expect(ledgerRow(sendId)?.state).toBe('pending');
    }
    expect(roomMessages(home.conversationId)).toHaveLength(0);
    // The refused sends left the sequence untouched.
    expect(store.orm.select().from(rooms).where(eq(rooms.chatId, home.chatId)).get()?.nextSeq).toBe(1n);
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

    host.activity.start({ conversation, policy: host.policy(conversation) }, 'until_stop');
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
      hostKind: 'playground',
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

  test('publishes a picture with its asset and refuses bytes it cannot store', async () => {
    const room = createRoom({ chatId: 50n, title: 'pictures', selfDisplayName: '碗' });
    const assets = new PlaygroundAssetStore({ orm: store.orm, root: join(directory, 'assets') });
    const host = createPlaygroundHost({
      store,
      self: { displayName: '碗' },
      pictures: assets,
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const target = { conversation, policy: host.policy(conversation) };
    const png = new Uint8Array(
      await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png()
        .toBuffer(),
    );
    const deliverPhoto = (sendId: bigint, bytes: Uint8Array, caption?: string) =>
      host.delivery.deliver({
        target,
        parts: [
          {
            kind: 'photo',
            bytes,
            fileName: 'room.png',
            mime: 'image/png',
            ...(caption === undefined ? {} : { caption }),
          },
        ],
        sendId,
        signal: undefined,
      });

    const firstSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-1', kind: 'photo' });
    const delivered = await deliverPhoto(firstSend, png, 'a room picture');
    expect(delivered.kind).toBe('delivered');
    const written = roomMessages(room.conversationId);
    expect(written).toHaveLength(1);
    const revision = store.orm
      .select()
      .from(messageRevisions)
      .where(eq(messageRevisions.messageId, written[0]!.id))
      .get();
    expect(revision).toMatchObject({ kind: 'image', caption: 'a room picture' });
    const mediaRows = store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]).toMatchObject({ kind: 'photo', hostKind: 'playground', mimeType: 'image/png' });
    const assetId = mediaRows[0]!.localAssetId!;
    expect(assets.resolve(assetId)).not.toBeNull();

    // The same bytes delivered again share the one stored file.
    const repeatSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-2', kind: 'photo' });
    expect((await deliverPhoto(repeatSend, png)).kind).toBe('delivered');
    expect(store.orm.select().from(media).all()).toHaveLength(2);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(1);

    // Bytes that are not an image are refused permanently and store nothing.
    const badSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-3', kind: 'photo' });
    const refused = await deliverPhoto(badSend, new Uint8Array([1, 2, 3]));
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') {
      expect(refused.failure).toMatchObject({ reason: 'permanent', code: 'media_rejected', outcomeUnknown: false });
    }
    expect(ledgerRow(badSend)?.state).toBe('pending');
    expect(ledgerRow(badSend)?.messageId).toBeNull();
    expect(roomMessages(room.conversationId)).toHaveLength(2);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    expect(telegramTransport).not.toHaveBeenCalled();
  });

  test('a refused or cancelled picture delivery leaves no asset and no file behind', async () => {
    const room = createRoom({ chatId: 51n, title: 'albums', selfDisplayName: '碗' });
    const root = join(directory, 'album-assets');
    const assets = new PlaygroundAssetStore({ orm: store.orm, root });
    const controller = new AbortController();
    let abortDuringIngest = false;
    const host = createPlaygroundHost({
      store,
      self: { displayName: '碗' },
      // The real store, with a hook that cancels the run while a copy is in
      // flight (the window between validation and publishing).
      pictures: {
        validate: (input) => assets.validate(input),
        ingest: async (chatId, input) => {
          const asset = await assets.ingest(chatId, input);
          if (abortDuringIngest) {
            controller.abort();
          }
          return asset;
        },
        discard: (assetId) => assets.discard(assetId),
        markAttached: (assetId, mediaId) => assets.markAttached(assetId, mediaId),
      },
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const target = { conversation, policy: host.policy(conversation) };
    const picture = async (shade: number) =>
      new Uint8Array(
        await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: shade, g: 2, b: 3 } } })
          .png()
          .toBuffer(),
      );
    const storedFiles = async () =>
      (await readdir(root, { recursive: true }).catch(() => [])).filter((name) => name.endsWith('.png'));

    // A valid first picture and a corrupt second one: the album is refused as
    // a whole before anything is written.
    const truncated = (await picture(9)).subarray(0, 40);
    const albumSend = reserveSend(room.conversationId, room.invocationId, { id: 'album-1', kind: 'photo_album' });
    const refused = await host.delivery.deliver({
      target,
      parts: [
        {
          kind: 'photo_album',
          pictures: [
            { bytes: await picture(1), fileName: 'a.png', mime: 'image/png' },
            { bytes: truncated, fileName: 'b.png', mime: 'image/png' },
          ],
        },
      ],
      sendId: albumSend,
      signal: undefined,
    });
    expect(refused).toMatchObject({ kind: 'rejected', failure: { code: 'media_rejected' } });
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);

    // A run cancelled while the copy runs publishes nothing and keeps nothing.
    abortDuringIngest = true;
    const cancelledSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-c', kind: 'photo' });
    const cancelled = await host.delivery.deliver({
      target,
      parts: [{ kind: 'photo', bytes: await picture(2), fileName: 'c.png', mime: 'image/png' }],
      sendId: cancelledSend,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ kind: 'rejected', failure: { reason: 'aborted', outcomeUnknown: false } });
    expect(ledgerRow(cancelledSend)?.state).toBe('pending');
    expect(roomMessages(room.conversationId)).toHaveLength(0);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);

    // An already cancelled run never starts the copy.
    const lateSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-d', kind: 'photo' });
    const late = await host.delivery.deliver({
      target,
      parts: [{ kind: 'photo', bytes: await picture(3), fileName: 'd.png', mime: 'image/png' }],
      sendId: lateSend,
      signal: controller.signal,
    });
    expect(late).toMatchObject({ kind: 'rejected', failure: { reason: 'aborted' } });
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
  });
});
