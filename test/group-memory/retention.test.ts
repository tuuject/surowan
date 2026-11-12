import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { media, messageRevisions, messages } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test('online retention never deletes chat messages, revisions or media', async () => {
  const f = await groupMemoryFixture();
  try {
    const firstId = seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-01-01T10:00:00.000Z'),
      text: 'old but kept',
    });
    const secondId = seedMessage(f.store, f, {
      telegramMessageId: 5000,
      date: new Date('2026-01-02T10:00:00.000Z'),
      text: 'also kept',
    });
    for (const [messageId, unique] of [
      [firstId, 'old-media'],
      [secondId, 'new-media'],
    ] as const) {
      const revision = f.store.orm
        .select({ id: messageRevisions.id })
        .from(messageRevisions)
        .where(eq(messageRevisions.messageId, messageId))
        .get();
      if (revision === undefined) {
        throw new Error('revision missing');
      }
      f.store.orm
        .insert(media)
        .values({
          revisionId: revision.id,
          kind: 'photo',
          fileId: `${unique}-file`,
          fileUniqueId: unique,
          telegramJson: '{}',
        })
        .run();
    }
    f.groupMemory.record(f.chatId, '2026-01-01', [
      { summary: 'a remembered event', firstMessageId: 4005n, lastMessageId: 4005n },
    ]);
    purgeExpiredData(f.store.orm, f.configStore.current().config, new Date('2026-10-01T00:00:00.000Z'));

    const remaining = f.store.orm.select().from(messages).all();
    expect(remaining.map((row) => row.telegramMessageId)).toEqual([4005n, 5000n]);
    expect(remaining.every((row) => row.currentRevisionId !== null)).toBe(true);
    const revisions = f.store.orm.select().from(messageRevisions).all();
    expect(revisions.map((row) => row.text)).toEqual(expect.arrayContaining(['old but kept', 'also kept']));
    expect(revisions.every((row) => row.senderId !== null)).toBe(true);
    expect(
      f.store.orm
        .select()
        .from(media)
        .all()
        .map((row) => row.fileUniqueId)
        .sort(),
    ).toEqual(['new-media', 'old-media']);
  } finally {
    await f.close();
  }
});
