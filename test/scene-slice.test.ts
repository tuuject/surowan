import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { conversationContextCutoffs, invocationMessages, messageRevisions } from '../src/store/schema.ts';
import {
  CONVERSATION,
  INVOCATION,
  OPENING_BUCKET,
  OTHER_CONVERSATION,
  OTHER_INVOCATION,
  OTHER_SEND,
  OUTSIDE_QUOTE,
  TARGET_ANSWER,
  at,
  cleanupFixtures,
  fixture,
  freeze,
  insertMessage,
  insertOtherConversation,
  insertSend,
} from './scene-slice-fixtures.ts';
import { buildSlice, expectSliceError } from './scene-slice-harness.ts';

/**
 * Bot-send slices: `buildSceneContext` with `beforeSendId` rebuilds only the
 * frozen public input that provably sat between the previous bot message and
 * one successful send of the invocation. These synthetic tests pin that
 * contract — the window, the eligible frozen batches, media/reply isolation and
 * the read-only guarantee — on top of `seedAdminFixture` (its chat,
 * conversation, invocations and send rows) plus rows written here.
 *
 * This file covers the window itself: which bot message opens it, which frozen
 * rows fall inside it at a shared timestamp, and how the conversation cutoff
 * still applies. Freezes and media live in `./scene-slice-snapshots.test.ts`,
 * send selection and budgets in `./scene-slice-sends.test.ts`. The fixture,
 * row builders and slice helpers live in `./scene-slice-fixtures.ts` and
 * `./scene-slice-harness.ts`.
 */

afterEach(cleanupFixtures);

test('builds a bot-send slice from the frozen inputs between two bot messages', async () => {
  const f = await fixture();
  // Neither row can have been read by a send that started at 08:00:03: one
  // arrived later, the other was only edited later.
  insertMessage(f.store, {
    id: 6_010n,
    revisionId: 6_110n,
    telegramMessageId: 899n,
    at: at(50),
    receivedAt: at(64),
    text: 'arrived after the send started',
  });
  freeze(f.store, { messageId: 6_010n, revisionId: 6_110n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_011n,
    revisionId: 6_111n,
    telegramMessageId: 898n,
    at: at(50),
    text: 'edited after the send started',
  });
  f.store.orm
    .update(messageRevisions)
    .set({ createdAt: at(64) })
    .where(eq(messageRevisions.id, 6_111n))
    .run();
  freeze(f.store, { messageId: 6_011n, revisionId: 6_111n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: null });
  expect(scene.cutoffAt).toBe(at(63));
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(2);
  expect(scene.omittedMessages).toBe(0);
  expect(scene.omittedImages).toBe(0);
  expect(scene.mediaRefs.size).toBe(0);
  expect(scene.bucketId).toBe(OPENING_BUCKET);
  expect(scene.conversationId).toBe(CONVERSATION);
  expect(scene.chatId).toBe(123_456_789n);
  expect(scene.threadId).toBe(0n);
  expect(scene.replyMessageIds).toEqual(['900', '901']);
  expect(scene.text.startsWith('<runtime_state>\ncurrent_time: ')).toBe(true);
  expect(scene.text).toContain('September 10, 2026 at 08:00:03 UTC (UTC)');
  expect(scene.text).not.toContain('<untrusted_telegram_history>');
  expect(scene.text).toContain('<untrusted_new_messages>');
  expect(scene.text).toContain('[900 07:59:30 uid:42 @alice] Alice\n  edited caption');
  expect(scene.text).toContain('[901 07:59:55 re:900 uid:42 @alice] Alice\n  plain text message with a reply');
  expect(scene.text.indexOf('[900 ')).toBeLessThan(scene.text.indexOf('[901 '));
  for (const leak of [
    TARGET_ANSWER,
    'Hello from the seeded invocation',
    'private reasoning',
    'edited text with forward origin',
    'arrived after the send started',
    'edited after the send started',
    OUTSIDE_QUOTE,
  ]) {
    expect(scene.text).not.toContain(leak);
  }
});

test("uses a previous bot message produced by another invocation's send", async () => {
  const f = await fixture();
  insertSend(f.store, {
    id: OTHER_SEND,
    toolCallId: 8_201n,
    callId: 'call_send_other_invocation',
    invocationId: OTHER_INVOCATION,
    telegramMessageId: 895n,
    createdAt: at(58),
  });
  insertMessage(f.store, {
    id: 6_020n,
    revisionId: 6_120n,
    telegramMessageId: 895n,
    at: at(58),
    text: 'other invocation reply',
    sentByBot: true,
  });
  insertMessage(f.store, {
    id: 6_021n,
    revisionId: 6_121n,
    telegramMessageId: 890n,
    at: at(50),
    text: 'before the other bot answer',
  });
  freeze(f.store, { messageId: 6_021n, revisionId: 6_121n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_022n,
    revisionId: 6_122n,
    telegramMessageId: 899n,
    at: at(59),
    text: 'after the other bot answer',
  });
  freeze(f.store, { messageId: 6_022n, revisionId: 6_122n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });
  // A frozen bot-owned input is still not public input.
  freeze(f.store, { messageId: 6_020n, revisionId: 6_120n, sequenceNo: 5n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '895' });
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('[899 07:59:59 uid:42 @alice] Alice\n  after the other bot answer');
  expect(scene.text).not.toContain('before the other bot answer');
  expect(scene.text).not.toContain('other invocation reply');
});

test('accepts a previous bot message that no send row produced', async () => {
  const f = await fixture();
  insertMessage(f.store, { id: 6_030n, revisionId: null, telegramMessageId: 880n, at: at(40), sentByBot: true });
  insertMessage(f.store, {
    id: 6_031n,
    revisionId: 6_131n,
    telegramMessageId: 875n,
    at: at(40),
    text: 'below the previous bot message',
  });
  freeze(f.store, { messageId: 6_031n, revisionId: 6_131n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_032n,
    revisionId: 6_132n,
    telegramMessageId: 885n,
    at: at(40),
    text: 'above the previous bot message',
  });
  freeze(f.store, { messageId: 6_032n, revisionId: 6_132n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '880' });
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('above the previous bot message');
  expect(scene.text).not.toContain('below the previous bot message');
});

test('keeps the window exact when every neighbor shares one second', async () => {
  const f = await fixture();
  const second = at(50);
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  insertOtherConversation(f.store);
  insertMessage(f.store, { id: 6_040n, revisionId: null, telegramMessageId: 880n, at: second, sentByBot: true });
  const frozen: ReadonlyArray<{
    readonly id: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly text: string;
    readonly conversationId?: bigint;
    readonly visible?: boolean;
  }> = [
    { id: 6_041n, revisionId: 6_141n, telegramMessageId: 870n, text: 'older than the previous bot' },
    { id: 6_042n, revisionId: 6_142n, telegramMessageId: 893n, text: 'window first' },
    { id: 6_043n, revisionId: 6_143n, telegramMessageId: 894n, text: 'unfrozen neighbor' },
    { id: 6_044n, revisionId: 6_144n, telegramMessageId: 896n, text: 'window second' },
    { id: 6_045n, revisionId: 6_145n, telegramMessageId: 897n, text: 'window third' },
    { id: 6_046n, revisionId: 6_146n, telegramMessageId: 898n, text: 'hidden boundary', visible: false },
    {
      id: 6_047n,
      revisionId: 6_147n,
      telegramMessageId: 899n,
      text: 'other topic words',
      conversationId: OTHER_CONVERSATION,
    },
    { id: 6_048n, revisionId: 6_148n, telegramMessageId: 905n, text: 'after the selected send' },
  ];
  let sequence = 1n;
  for (const entry of frozen) {
    insertMessage(f.store, {
      id: entry.id,
      revisionId: entry.revisionId,
      telegramMessageId: entry.telegramMessageId,
      at: second,
      text: entry.text,
      ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
      ...(entry.visible === undefined ? {} : { visible: entry.visible }),
    });
    // The unfrozen neighbor exists as a stored message only, never as input.
    if (entry.telegramMessageId !== 894n) {
      freeze(f.store, {
        messageId: entry.id,
        revisionId: entry.revisionId,
        sequenceNo: sequence,
        sourceBucketId: OPENING_BUCKET,
      });
      sequence += 1n;
    }
  }

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '880' });
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(3);
  expect(scene.replyMessageIds).toEqual(['893', '896', '897']);
  expect(scene.text).toContain('[893 07:59:50 uid:42 @alice] Alice\n  window first');
  expect(scene.text).toContain('[896 07:59:50 uid:42 @alice] Alice\n  window second');
  expect(scene.text).toContain('[897 07:59:50 uid:42 @alice] Alice\n  window third');
  for (const leak of [
    'older than the previous bot',
    'unfrozen neighbor',
    'hidden boundary',
    'other topic words',
    'after the selected send',
  ]) {
    expect(scene.text).not.toContain(leak);
  }
});

test('still applies the conversation context cutoff inside a slice', async () => {
  const f = await fixture();
  f.store.orm
    .insert(conversationContextCutoffs)
    .values({ conversationId: CONVERSATION, telegramMessageId: 900n, createdAt: at(61), updatedAt: at(61) })
    .run();

  const scene = buildSlice(f);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  plain text message with a reply');
  expect(scene.text).not.toContain('edited caption');

  f.store.orm
    .update(conversationContextCutoffs)
    .set({ telegramMessageId: 901n })
    .where(eq(conversationContextCutoffs.conversationId, CONVERSATION))
    .run();
  expectSliceError(() => buildSlice(f), 'replay_slice_empty');
});
