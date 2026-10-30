import { eq, sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { deleteTelegramChatData } from '../../src/ingress/admin/chats.ts';
import { diffConfig } from '../../src/platform/config/diff.ts';
import {
  chatMigrations,
  chats,
  conversations,
  memoBlobs,
  memoPadEntries,
  messageRevisions,
  messages,
} from '../../src/store/schema/index.ts';
import { pathExists } from '../helpers.ts';
import type { MemoFixture } from './fixtures.ts';
import { memoFixture, seedChat } from './fixtures.ts';

const fixtures: MemoFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

async function fixture(): Promise<MemoFixture> {
  const created = await memoFixture();
  fixtures.push(created);
  return created;
}

test('deleteTelegramChatData removes the Chat row, conversations, Memo entries, blob rows and blob files', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const entry = f.memoPad.create(chat.chatId, { summary: 'doomed', detail: 'detail' });
  const stored = await f.blobs.ingest(chat.chatId, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
  const blobPath = f.blobs.absolutePath(stored.blob);
  expect(await pathExists(blobPath)).toBe(true);
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const message = f.store.orm
    .insert(messages)
    .values({
      conversationId: chat.conversationId,
      chatId: chat.chatId,
      telegramMessageId: 1n,
      telegramDate: now,
      receivedAt: now,
    })
    .returning({ id: messages.id })
    .get();
  if (message === undefined) {
    throw new Error('message insert returned no row');
  }
  const revision = f.store.orm
    .insert(messageRevisions)
    .values({
      messageId: message.id,
      revisionNo: 1n,
      kind: 'text',
      text: 'hello',
      createdAt: now,
      rawFragmentJson: '{}',
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (revision === undefined) {
    throw new Error('revision insert returned no row');
  }
  f.store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, message.id)).run();

  expect(await deleteTelegramChatData(f.store, f.blobs, chat.telegramChatId)).toBe(true);

  expect(f.store.orm.select().from(chats).all()).toEqual([]);
  expect(f.store.orm.select().from(conversations).all()).toEqual([]);
  expect(f.store.orm.select().from(memoPadEntries).all()).toEqual([]);
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual([]);
  expect(await pathExists(blobPath)).toBe(false);
  expect(f.memoPad.get(entry.id, chat.chatId)).toBeUndefined();

  expect(await deleteTelegramChatData(f.store, f.blobs, chat.telegramChatId)).toBe(false);
});

test('a configuration diff that removes the Chat never deletes its stored data', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const entry = f.memoPad.create(chat.chatId, { summary: 'kept', detail: 'detail' });
  const stored = await f.blobs.ingest(chat.chatId, { bytes: new Uint8Array([4, 5, 6]), mime: 'image/png' });

  const nextFile = structuredClone(f.loaded.fileConfig);
  if (nextFile.telegram === undefined) {
    throw new Error('the fixture always configures a telegram section');
  }
  nextFile.telegram.chats = [];
  const diff = diffConfig(
    { file: f.loaded.fileConfig, raw: f.loaded.config },
    { file: nextFile, raw: f.loaded.config },
  );
  expect(diff.changes.map((change) => change.path)).toContain('telegram.chats[123456789]');
  expect(diff.candidate.file.telegram?.chats).toEqual([]);

  // Only an explicit Admin delete removes the stored rows and files.
  expect(f.store.orm.select().from(chats).all()).toHaveLength(1);
  expect(f.memoPad.get(entry.id, chat.chatId)).toBeDefined();
  expect(f.blobs.get(stored.blob.id, chat.chatId)).toBeDefined();
  expect(await pathExists(f.blobs.absolutePath(stored.blob))).toBe(true);
  expect(
    f.store.orm.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`),
  ).toBeUndefined();
});

test('deleteTelegramChatData resolves a configured id through chat_migrations', async () => {
  const f = await fixture();
  const runtime = seedChat(f.store, 222n);
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: 111n, newChatId: 222n, receivedAt: new Date().toISOString() })
    .run();
  const entry = f.memoPad.create(runtime.chatId, { summary: 'migrated', detail: 'detail' });
  const stored = await f.blobs.ingest(runtime.chatId, { bytes: new Uint8Array([10, 11]), mime: 'image/png' });

  expect(await deleteTelegramChatData(f.store, f.blobs, 111n)).toBe(true);
  expect(f.store.orm.select().from(chats).all()).toEqual([]);
  expect(f.memoPad.get(entry.id, runtime.chatId)).toBeUndefined();
  expect(f.blobs.get(stored.blob.id, runtime.chatId)).toBeUndefined();
  expect(f.store.orm.select().from(chatMigrations).all()).toEqual([]);
});
