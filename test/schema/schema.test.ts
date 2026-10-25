import { afterAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  bucketMessages,
  buckets,
  chats,
  conversations,
  memories,
  messages,
  schemaMigrations,
  stickerSets,
  telegramUpdates,
} from '../../src/store/schema/index.ts';
import { cleanupSchemaDirectories, openStore } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

test('drizzle layer reads migration versions as bigint', async () => {
  const { store } = await openStore();
  try {
    const versions = store.orm
      .select()
      .from(schemaMigrations)
      .all()
      .map((row) => row.version);
    expect(versions.length).toBeGreaterThanOrEqual(14);
    for (const version of versions) {
      expect(typeof version).toBe('bigint');
    }
  } finally {
    store.close();
  }
});

test('drizzle layer round-trips bigint and boolean columns', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const inserted = store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .returning({ id: chats.id, telegramChatId: chats.telegramChatId })
      .get();
    expect(inserted?.id).toBe(1n);
    expect(typeof inserted?.id).toBe('bigint');
    expect(inserted?.telegramChatId).toBe(123456789n);

    const allowed = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 10n, chatId: 123456789n, chatType: 'private', receivedAt: now, allowed: true, rawJson: '{}' })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(allowed?.allowed).toBe(true);
    expect(typeof allowed?.allowed).toBe('boolean');

    const rejected = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 11n, receivedAt: now, allowed: false })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(rejected?.allowed).toBe(false);
  } finally {
    store.close();
  }
});

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
        .insert(memories)
        .values({
          id: 'm1',
          conversationId: 1n,
          content: 'x'.repeat(151),
          createdAt: now,
          expiresAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
          updatedAt: now,
        })
        .run();
    }).toThrow();
    const count = store.orm
      .select({ count: sql<bigint>`count(*)` })
      .from(memories)
      .where(eq(memories.conversationId, 1n))
      .get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('the room timeline reads an input state through the message index', async () => {
  const { store } = await openStore();
  try {
    const plan = store.db
      .prepare<[bigint], { detail: string }>(
        'EXPLAIN QUERY PLAN SELECT state FROM playground_inputs WHERE message_id = ?',
      )
      .all(1n)
      .map((row) => row.detail);
    expect(plan.join('\n')).toContain('USING INDEX playground_inputs_message_idx');
  } finally {
    store.close();
  }
});
