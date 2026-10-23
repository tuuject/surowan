/**
 * T03 acceptance: a Bot Playground room publishes its own messages.
 *
 * The room has no wire, so the tests here drive the real send pipeline against
 * a real store and check the ledger, the message it produced, and every way a
 * delivery is refused - always with an explicit reason, never a fake success.
 *
 * The refusals, identity/reply and picture suites continue this one in
 * `playground-delivery-{refusals,identity,pictures}.test.ts` and share
 * `playground-delivery-fixtures.ts`.
 */
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSendTools } from '../src/capabilities/send-tool.ts';
import { InvocationContextState } from '../src/platform/invocation-context.ts';
import { identityConversation } from '../src/platform/im-host.ts';
import { hostSends, messageRevisions, rooms, toolCalls } from '../src/store/schema.ts';
import {
  createRoom,
  deliver,
  hostFor,
  ledgerRow,
  reserveSend,
  roomMessages,
  store,
  telegramTransport,
} from './playground-delivery-fixtures.ts';

describe('Bot Playground virtual delivery', () => {
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
});
