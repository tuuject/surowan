import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { media, messageRevisions, messages } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test('retention keeps raw messages cited by a group memory and removes the rest', async () => {
  const f = await groupMemoryFixture();
  try {
    const citedMessageId = seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-01-01T10:00:00.000Z'),
      text: 'cited by memory',
    });
    const removedMessageId = seedMessage(f.store, f, {
      telegramMessageId: 5000,
      date: new Date('2026-01-02T10:00:00.000Z'),
      text: 'not cited',
    });
    for (const [messageId, unique] of [
      [citedMessageId, 'cited-media'],
      [removedMessageId, 'removed-media'],
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
    f.groupMemory.commit(
      f.chatId,
      '2026-01-01',
      [{ summary: 'a remembered event', firstMessageId: 4005n, lastMessageId: 4005n }],
      4005n,
    );
    purgeExpiredData(f.store.orm, f.configStore.current().config, new Date('2026-10-01T00:00:00.000Z'));

    const remaining = f.store.orm.select().from(messages).all();
    expect(remaining.map((row) => row.telegramMessageId)).toEqual([4005n]);
    expect(remaining[0]?.currentRevisionId).not.toBeNull();
    const revision = f.store.orm
      .select()
      .from(messageRevisions)
      .where(eq(messageRevisions.messageId, remaining[0]!.id))
      .get();
    expect(revision?.text).toBe('cited by memory');
    expect(
      f.store.orm
        .select()
        .from(media)
        .all()
        .map((row) => row.fileUniqueId),
    ).toEqual(['cited-media']);
  } finally {
    await f.close();
  }
});
