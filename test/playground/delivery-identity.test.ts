/**
 * Bot Playground virtual delivery: identity, replies and local activity.
 *
 * The bot that writes in a room belongs to that room, survives a namesake and
 * retention, a reply names the room sequence it carries and links the stored
 * row, and a room never shows a chat action.
 */
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { identityConversation, PLAYGROUND_ACTIVITY_CAP_MS } from '../../src/platform/im-host.ts';
import { invocations, messageRevisions, roomParticipants, rooms, senders } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import {
  createRoom,
  deliver,
  hostFor,
  ledgerRow,
  NOW,
  reserveSend,
  roomMessages,
  store,
  telegramTransport,
} from './delivery-fixtures.ts';

describe('Bot Playground virtual delivery', () => {
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
});
