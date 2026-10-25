import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { chats } from '../src/store/schema/index.ts';
import type { BusinessStore, Orm } from '../src/store/store.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function insertChat(orm: Orm, id: bigint): void {
  orm
    .insert(chats)
    .values({ telegramChatId: id, canonicalChatId: id, type: 'private', updatedAt: new Date().toISOString() })
    .run();
}

test('business store provides atomic rollback and exact bigint IDs across SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-store-contract-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const { config } = await loadConfig(configPath);
  const native = await SqliteStore.open(config);
  const store: BusinessStore = native;
  const largeId = 9_007_199_254_740_991n;
  try {
    expect(() =>
      store.transaction(() => {
        insertChat(store.orm, largeId - 1n);
        throw new Error('rollback sentinel');
      }),
    ).toThrow('rollback sentinel');
    expect(
      store.orm
        .select()
        .from(chats)
        .where(eq(chats.telegramChatId, largeId - 1n))
        .get(),
    ).toBeUndefined();
    store.transaction(() => insertChat(store.orm, largeId));
    expect(store.orm.select().from(chats).where(eq(chats.telegramChatId, largeId)).get()?.telegramChatId).toBe(largeId);
  } finally {
    native.close();
  }
  const reopened = await SqliteStore.open(config);
  try {
    const row = reopened.orm.select().from(chats).where(eq(chats.telegramChatId, largeId)).get();
    expect(row?.telegramChatId).toBe(largeId);
    expect(typeof row?.id).toBe('bigint');
  } finally {
    reopened.close();
  }
});
