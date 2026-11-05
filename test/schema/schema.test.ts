import { afterAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  bucketMessages,
  buckets,
  chats,
  conversations,
  memoPadEntries,
  messages,
  stickerSets,
} from '../../src/store/schema/index.ts';
import { cleanupSchemaDirectories, openStore } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

test('strict tables still reject text values in integer columns through sql templates', async () => {
  const { store } = await openStore();
  try {
    expect(() => {
      // The typed layer would refuse this; reach around it to prove SQLite
      // STRICT still guards the raw boundary.
      store.orm.run(sql`INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, updated_at)
        VALUES (1, ${'not-a-number'}, 123456789, 'private', '2026-09-01T00:00:00.000Z')`);
    }).toThrow();
    const count = store.orm.select({ count: sql<bigint>`count(*)` }).from(chats).get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('drizzle statements join better-sqlite3 immediate transactions and roll back on throw', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    store.orm
      .insert(messages)
      .values({ id: 1n, conversationId: 1n, chatId: 1n, telegramMessageId: 5n, telegramDate: now, receivedAt: now })
      .run();
    expect(() => {
      store.transaction(() => {
        store.orm
          .insert(buckets)
          .values({
            id: 1n,
            conversationId: 1n,
            state: 'collecting',
            firstReceivedAt: now,
            deadlineAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        store.orm.insert(bucketMessages).values({ bucketId: 1n, messageId: 1n, sequenceNo: 0n }).run();
        throw new Error('rollback');
      });
    }).toThrow('rollback');
    const bucketCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(buckets).get();
    expect(bucketCount?.count).toBe(0n);
    const bucketMessageCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(bucketMessages).get();
    expect(bucketMessageCount?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('sql templates bind bigint parameters and query the fts5 virtual table', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const set = store.orm
      .insert(stickerSets)
      .values({ alias: 'cats', telegramName: 'cat_set', updatedAt: now })
      .returning({ id: stickerSets.id })
      .get();
    expect(typeof set?.id).toBe('bigint');
    store.orm.run(
      sql`INSERT INTO sticker_search (sticker_id, description) VALUES (${set?.id ?? 0n}, ${'a happy cat'})`,
    );
    const matched = store.orm.all<{ sticker_id: bigint }>(
      sql`SELECT sticker_id FROM sticker_search WHERE sticker_search MATCH ${'cat'}`,
    );
    expect(matched[0]?.sticker_id).toBe(set?.id);

    const bound = store.orm.all<{ n: bigint }>(sql`SELECT ${9007199254740993n} AS n`);
    expect(bound[0]?.n).toBe(9007199254740993n);
  } finally {
    store.close();
  }
});

test('drizzle layer preserves check constraints from the sql migrations', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    expect(() => {
      store.orm
        .insert(memoPadEntries)
        .values({
          id: 'mem_cccccccccccccccccccccccccccccccc',
          chatId: 1n,
          summary: 'x'.repeat(151),
          detail: 'x',
          createdAt: now,
          expiresAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
          updatedAt: now,
        })
        .run();
    }).toThrow();
    const count = store.orm
      .select({ count: sql<bigint>`count(*)` })
      .from(memoPadEntries)
      .where(eq(memoPadEntries.chatId, 1n))
      .get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});
