import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { invocationMessages } from '../src/store/schema.ts';
import {
  FAILED_SEND,
  INVOCATION,
  MESSAGE_HISTORY,
  NO_MESSAGE_SEND,
  OPENING_BUCKET,
  OTHER_CONVERSATION,
  OTHER_INVOCATION,
  OTHER_SEND,
  REVISION_A1,
  SECOND_SEND,
  WRONG_CONVERSATION_SEND,
  at,
  cleanupFixtures,
  fixture,
  freeze,
  insertMessage,
  insertOtherConversation,
  insertSend,
  setFrozenRevision,
} from './scene-slice-fixtures.ts';
import { buildSlice, databaseRows, expectSliceError } from './scene-slice-harness.ts';

/**
 * Bot-send slice targets and limits: only a successful, same-conversation send
 * of this invocation may anchor the window, consecutive sends leave an empty
 * slice, the character budget keeps the newest input, and building never
 * writes. Fixture and row builders live in `./scene-slice-fixtures.ts`.
 */

afterEach(cleanupFixtures);

test("rejects sends that are not this invocation's successful same-conversation send", async () => {
  const f = await fixture();
  insertOtherConversation(f.store);
  insertSend(f.store, {
    id: OTHER_SEND,
    toolCallId: 8_301n,
    callId: 'call_send_wrong_invocation',
    invocationId: OTHER_INVOCATION,
    telegramMessageId: 906n,
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: WRONG_CONVERSATION_SEND,
    toolCallId: 8_302n,
    callId: 'call_send_wrong_conversation',
    invocationId: INVOCATION,
    conversationId: OTHER_CONVERSATION,
    telegramMessageId: 907n,
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: FAILED_SEND,
    toolCallId: 8_303n,
    callId: 'call_send_failed',
    invocationId: INVOCATION,
    telegramMessageId: 908n,
    state: 'error',
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: NO_MESSAGE_SEND,
    toolCallId: 8_304n,
    callId: 'call_send_without_message',
    invocationId: INVOCATION,
    telegramMessageId: null,
    createdAt: at(70),
  });

  for (const id of [OTHER_SEND, WRONG_CONVERSATION_SEND, FAILED_SEND, NO_MESSAGE_SEND, 999_999n]) {
    expectSliceError(() => buildSlice(f, { beforeSendId: id }), 'replay_slice_target_invalid');
  }
  expect(buildSlice(f).messageCount).toBe(2);
});

test('sees no input between two consecutive sends of one invocation', async () => {
  const f = await fixture();
  insertSend(f.store, {
    id: SECOND_SEND,
    toolCallId: 8_401n,
    callId: 'call_send_second',
    invocationId: INVOCATION,
    telegramMessageId: 905n,
    createdAt: at(67),
  });
  insertMessage(f.store, {
    id: 6_060n,
    revisionId: 6_160n,
    telegramMessageId: 905n,
    at: at(67),
    text: 'second answer',
    sentByBot: true,
  });
  insertMessage(f.store, {
    id: 6_061n,
    revisionId: 6_161n,
    telegramMessageId: 903n,
    at: at(64),
    text: 'retained but never frozen',
  });

  expectSliceError(() => buildSlice(f, { beforeSendId: SECOND_SEND }), 'replay_slice_empty');
  expect(buildSlice(f).messageCount).toBe(2);

  // A provable input in that window renders alone; the unfrozen neighbor stays out.
  insertMessage(f.store, {
    id: 6_062n,
    revisionId: 6_162n,
    telegramMessageId: 904n,
    at: at(65),
    text: 'frozen between the two sends',
  });
  freeze(f.store, { messageId: 6_062n, revisionId: 6_162n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  const scene = buildSlice(f, { beforeSendId: SECOND_SEND });
  expect(scene.slice).toEqual({ beforeSendId: '8102', beforeMessageId: '905', afterBotMessageId: '902' });
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  frozen between the two sends');
  expect(scene.text).not.toContain('retained but never frozen');
  expect(scene.text).not.toContain('second answer');
});

test('trims the slice to the character budget keeping the newest input', async () => {
  const f = await fixture();
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  for (let index = 0; index < 6; index += 1) {
    const id = 6_070n + BigInt(index);
    const revisionId = 6_170n + BigInt(index);
    insertMessage(f.store, {
      id,
      revisionId,
      telegramMessageId: 880n + BigInt(index),
      at: at(10 + index),
      text: `budget ${index} ${'x'.repeat(200)}`,
    });
    freeze(f.store, { messageId: id, revisionId, sequenceNo: BigInt(index + 1), sourceBucketId: OPENING_BUCKET });
  }

  const scene = buildSlice(f, { contextWindow: 320, maxOutputTokens: 0, toolDefinitionCharacters: 0 });

  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBeGreaterThanOrEqual(1);
  expect(scene.messageCount).toBeLessThan(6);
  expect(scene.omittedMessages).toBe(6 - scene.messageCount);
  expect(scene.text).toContain('budget 5');
  expect(scene.text).not.toContain('budget 0');
  expect(scene.text).toContain(`[${6 - scene.messageCount} earlier new messages omitted to fit the model context]`);
});

test('never writes while building a slice', async () => {
  const f = await fixture();
  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const before = databaseRows(f.store);
  expect(
    f.store.orm.select().from(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).all(),
  ).toHaveLength(2);
  expect(before.context_refs).toHaveLength(1);

  const scene = buildSlice(f, { supportsImages: true });

  expect(scene.mediaRefs.size).toBe(1);
  expect(databaseRows(f.store)).toEqual(before);
});
