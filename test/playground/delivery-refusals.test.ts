/**
 * Bot Playground virtual delivery: the refusals.
 *
 * A room publishes only into itself, only what it can carry and store, and
 * only one part at a time - every refusal names its reason and leaves the
 * ledger row pending with no message behind it.
 */
import { describe, expect, test } from 'vitest';
import { identityConversation } from '../../src/platform/im-host/identity.ts';
import { chats, conversations } from '../../src/store/schema/index.ts';
import { createRoom, deliver, hostFor, ledgerRow, NOW, reserveSend, roomMessages, store } from './delivery-fixtures.ts';

describe('Bot Playground virtual delivery', () => {
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
});
