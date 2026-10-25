import { afterAll, describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { buildSceneContext } from '../../src/context/scene/index.ts';
import { invocationMessages, media } from '../../src/store/schema/index.ts';
import {
  DEFAULT_OPTIONS,
  GROUP_CHAT,
  at,
  chatRowId,
  cleanupDirectories,
  conversationIdOf,
  flush,
  latestInvocation,
  photoUpdate,
  setup,
} from './context-fixtures.ts';

afterAll(cleanupDirectories);

describe('scene context', () => {
  test('marks media as unavailable or missing and reports it without loading bytes', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(photoUpdate(1, 10, 'history photo', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);

    const first = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(first.omittedImages).toBe(2);
    expect(first.mediaIds).toHaveLength(2);
    expect(first.text.match(/\[photo media_unavailable 800x600\]/g)).toHaveLength(2);
    expect(first.text).toContain('  history photo');
    expect(first.text).toContain('  trigger photo');
    expect(first.text).not.toMatch(/img_|figure_/);

    // The trigger's media row disappears (retention) while its snapshot remains.
    const triggerRevision = store.orm
      .all<{ revision_id: bigint }>(
        sql`SELECT m.current_revision_id AS revision_id FROM messages m
            WHERE m.chat_id = ${chatRowId(store, GROUP_CHAT)} AND m.telegram_message_id = 11`,
      )
      .at(0);
    if (triggerRevision === undefined) {
      throw new Error('fixture: trigger revision is missing');
    }
    store.orm.delete(media).where(eq(media.revisionId, triggerRevision.revision_id)).run();

    const second = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(second.omittedImages).toBe(2);
    expect(second.text.match(/\[photo media_missing 800x600\]/g)).toHaveLength(1);
    expect(second.text.match(/\[photo media_unavailable 800x600\]/g)).toHaveLength(1);
    store.close();
  });

  test('image references authorize only rendered retained media from the frozen revision', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(photoUpdate(1, 10, `old photo ${'x'.repeat(1_024)}`, 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
    const options = { ...DEFAULT_OPTIONS, supportsImages: true };
    const before = store.db.prepare('SELECT * FROM context_refs').all();
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, options);
    expect(scene.mediaRefs.size).toBe(2);
    expect(scene.omittedImages).toBe(0);
    expect([...scene.mediaRefs.keys()].every((ref) => scene.text.includes(ref))).toBe(true);
    const trimmed = buildSceneContext(store, fixture.loaded.config, invocationId, {
      ...options,
      contextWindow: 256,
      maxOutputTokens: 0,
      toolDefinitionCharacters: 0,
    });
    expect(trimmed.mediaRefs.size).toBe(1);
    expect(trimmed.historyCount).toBe(0);
    expect(trimmed.omittedMessages).toBe(1);
    expect(trimmed.text).not.toContain('old photo');
    expect([...trimmed.mediaRefs.keys()].every((ref) => trimmed.text.includes(ref))).toBe(true);
    const rows = store.orm
      .select()
      .from(invocationMessages)
      .where(eq(invocationMessages.invocationId, invocationId))
      .orderBy(invocationMessages.sequenceNo)
      .all();
    const opening = rows.at(-1)!;
    const history = rows[0]!;
    const openingSnapshot = JSON.parse(opening.snapshotJson);
    const historySnapshot = JSON.parse(history.snapshotJson);
    openingSnapshot.media[0].id = historySnapshot.media[0].id;
    store.orm
      .update(invocationMessages)
      .set({ snapshotJson: JSON.stringify(openingSnapshot) })
      .where(
        and(eq(invocationMessages.invocationId, invocationId), eq(invocationMessages.messageId, opening.messageId)),
      )
      .run();
    const forged = buildSceneContext(store, fixture.loaded.config, invocationId, options);
    expect(forged.mediaRefs.size).toBe(1);
    expect(forged.omittedImages).toBe(1);
    expect(forged.text).toContain('media_missing');
    expect(store.db.prepare('SELECT * FROM context_refs').all()).toEqual(before);
    store.close();
  });

  test.each(['new', 'history'])(
    'rejects %s media when its frozen revision belongs to another message',
    async (section) => {
      const fixture = await setup();
      const { store, ingestion } = fixture;
      try {
        ingestion.ingest(photoUpdate(1, 10, 'history photo', 0), at(0));
        flush(fixture, 20);
        ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
        flush(fixture, 50);
        const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
        const rows = store.orm
          .select()
          .from(invocationMessages)
          .where(eq(invocationMessages.invocationId, invocationId))
          .all();
        const target = rows.find((row) => row.section === section)!;
        const other = rows.find((row) => row.section !== section)!;
        const snapshot = JSON.parse(target.snapshotJson);
        snapshot.media = JSON.parse(other.snapshotJson).media;
        store.orm
          .update(invocationMessages)
          .set({ revisionId: other.revisionId, snapshotJson: JSON.stringify(snapshot) })
          .where(
            and(
              eq(invocationMessages.invocationId, invocationId),
              eq(invocationMessages.sequenceNo, target.sequenceNo),
            ),
          )
          .run();
        const before = store.db.prepare('SELECT * FROM invocation_messages').all();
        expect(() =>
          buildSceneContext(store, fixture.loaded.config, invocationId, { ...DEFAULT_OPTIONS, supportsImages: true }),
        ).toThrow(/Scene context:.*snapshot/);
        expect(store.db.prepare('SELECT * FROM invocation_messages').all()).toEqual(before);
        expect(store.db.prepare('SELECT * FROM context_refs').all()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );
});
