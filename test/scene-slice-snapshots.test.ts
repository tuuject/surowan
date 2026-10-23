import { eq, sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { contextRefs, invocationMessages, media, messageRevisions, messages } from '../src/store/schema.ts';
import {
  ALICE,
  INVOCATION,
  MEDIA_PHOTO,
  MESSAGE_HISTORY,
  MESSAGE_OPENING,
  OPENING_BUCKET,
  OUTSIDE_QUOTE,
  REVISION_A1,
  REVISION_A2,
  REVISION_B1,
  REVISION_B2,
  REVISION_REFRESH,
  at,
  attachBucket,
  cleanupFixtures,
  fixture,
  freeze,
  insertBucket,
  insertMessage,
  setFrozenRevision,
} from './scene-slice-fixtures.ts';
import { buildSlice } from './scene-slice-harness.ts';

/**
 * Bot-send slice inputs: only batches that were already injected when the send
 * started, only the snapshot frozen at or before it, reply references kept only
 * for rendered messages, and media authorized only through the frozen revision.
 * Fixture and row builders live in `./scene-slice-fixtures.ts`.
 */

afterEach(cleanupFixtures);

test('injects only attached batches that were already injected when the send started', async () => {
  const f = await fixture();
  const injected = 3_101n;
  const never = 3_102n;
  const later = 3_103n;
  const tied = 3_104n;
  for (const id of [injected, never, later, tied]) {
    insertBucket(f.store, id);
  }
  attachBucket(f.store, injected, at(62));
  attachBucket(f.store, never, null);
  attachBucket(f.store, later, at(64));
  attachBucket(f.store, tied, at(63));
  const batches: ReadonlyArray<{
    readonly id: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly bucket: bigint;
    readonly text: string;
  }> = [
    { id: 6_050n, revisionId: 6_150n, telegramMessageId: 890n, bucket: injected, text: 'injected batch words' },
    { id: 6_051n, revisionId: 6_151n, telegramMessageId: 891n, bucket: never, text: 'never injected words' },
    { id: 6_052n, revisionId: 6_152n, telegramMessageId: 892n, bucket: later, text: 'future injected words' },
    { id: 6_053n, revisionId: 6_153n, telegramMessageId: 893n, bucket: tied, text: 'ambiguous injection words' },
  ];
  let sequence = 3n;
  for (const batch of batches) {
    insertMessage(f.store, {
      id: batch.id,
      revisionId: batch.revisionId,
      telegramMessageId: batch.telegramMessageId,
      at: at(10),
      text: batch.text,
    });
    freeze(f.store, {
      messageId: batch.id,
      revisionId: batch.revisionId,
      sequenceNo: sequence,
      sourceBucketId: batch.bucket,
    });
    sequence += 1n;
  }

  const scene = buildSlice(f);

  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('  injected batch words');
  expect(scene.text).not.toContain('never injected words');
  expect(scene.text).not.toContain('future injected words');
  expect(scene.text).not.toContain('ambiguous injection words');
});

test('renders the newest eligible snapshot when one message was frozen twice', async () => {
  const f = await fixture();
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  f.store.orm
    .insert(messageRevisions)
    .values({
      id: REVISION_REFRESH,
      messageId: MESSAGE_OPENING,
      revisionNo: 3n,
      senderId: ALICE,
      kind: 'text',
      text: 're-frozen newer words',
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: at(57),
      rawFragmentJson: '{}',
    })
    .run();
  freeze(f.store, { messageId: MESSAGE_OPENING, revisionId: REVISION_B1, section: 'history', sequenceNo: 1n });
  freeze(f.store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_REFRESH,
    sequenceNo: 2n,
    sourceBucketId: OPENING_BUCKET,
  });

  const scene = buildSlice(f);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  re-frozen newer words');
  expect(scene.text).not.toContain('plain text message with a reply');
  expect(scene.text.match(/\[901 /g)).toHaveLength(1);

  // An even later freeze of the same message cannot win: its revision was
  // created after the send started, so it is not provable input.
  freeze(f.store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_B2,
    sequenceNo: 3n,
    sourceBucketId: OPENING_BUCKET,
  });
  const guarded = buildSlice(f);
  expect(guarded.messageCount).toBe(1);
  expect(guarded.text).toContain('  re-frozen newer words');
  expect(guarded.text).not.toContain('edited text with forward origin');
});

test("renders the frozen snapshot, never the message's latest edit", async () => {
  const f = await fixture();

  const scene = buildSlice(f);

  expect(scene.text).toContain('  plain text message with a reply');
  expect(scene.text).not.toContain('edited text with forward origin');
  const live = f.store.orm
    .all<{ text: string | null }>(
      sql`SELECT r.text FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id
          WHERE m.id = ${MESSAGE_OPENING}`,
    )
    .at(0);
  expect(live?.text).toBe('edited text with forward origin');
});

test('keeps reply references only for messages inside the slice', async () => {
  const f = await fixture();

  const included = buildSlice(f);
  expect(included.replyMessageIds).toEqual(['900', '901']);
  expect(included.text).toContain('[901 07:59:55 re:900 uid:42 @alice] Alice');
  expect(included.text).not.toContain(`> Bot: ${OUTSIDE_QUOTE}`);

  // The replied-to message becomes the previous bot message: its reference
  // leaves the window and the reply must not carry any trace of it.
  f.store.orm.update(messages).set({ sentByBot: true }).where(eq(messages.id, MESSAGE_HISTORY)).run();
  const trimmed = buildSlice(f);
  expect(trimmed.slice?.afterBotMessageId).toBe('900');
  expect(trimmed.messageCount).toBe(1);
  expect(trimmed.replyMessageIds).toEqual(['901']);
  expect(trimmed.text).toContain('  plain text message with a reply');
  expect(trimmed.text).not.toContain('re:900');
  expect(trimmed.text).not.toContain(OUTSIDE_QUOTE);
});

test('authorizes only frozen-revision media and only for rendered messages', async () => {
  const f = await fixture();
  const refsBefore = f.store.orm.select().from(contextRefs).all();
  expect(refsBefore).toHaveLength(1);

  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const scene = buildSlice(f, { supportsImages: true });
  const ref = [...scene.mediaRefs.keys()].at(0);
  expect(scene.mediaRefs.size).toBe(1);
  expect([...scene.mediaRefs.values()]).toEqual([MEDIA_PHOTO]);
  expect(ref).toBeDefined();
  expect(scene.omittedImages).toBe(0);
  expect(scene.text).toContain(`[photo ${ref} 1280x720]`);
  expect(scene.text).toContain('  first caption');

  // The retained media row is moved to a revision the frozen snapshot does not
  // name: it must be reported missing, never authorized.
  f.store.orm.update(media).set({ revisionId: REVISION_A2 }).where(eq(media.id, MEDIA_PHOTO)).run();
  const orphaned = buildSlice(f, { supportsImages: true });
  expect(orphaned.mediaRefs.size).toBe(0);
  expect(orphaned.omittedImages).toBe(1);
  expect(orphaned.text).toContain('[photo media_missing 1280x720]');

  // A message dropped by the character budget carries no reference either.
  f.store.orm.update(media).set({ revisionId: REVISION_A1 }).where(eq(media.id, MEDIA_PHOTO)).run();
  f.store.orm
    .update(messageRevisions)
    .set({ caption: 'x'.repeat(2_000) })
    .where(eq(messageRevisions.id, REVISION_A1))
    .run();
  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const trimmed = buildSlice(f, {
    supportsImages: true,
    contextWindow: 320,
    maxOutputTokens: 0,
    toolDefinitionCharacters: 0,
  });
  expect(trimmed.messageCount).toBe(1);
  expect(trimmed.omittedMessages).toBe(1);
  expect(trimmed.mediaRefs.size).toBe(0);
  expect(trimmed.omittedImages).toBe(0);
  expect(trimmed.text).not.toContain('img_');

  expect(f.store.orm.select().from(contextRefs).all()).toEqual(refsBefore);
});
