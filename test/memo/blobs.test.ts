import type * as fs from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoBlobStore } from '../../src/context/memo-pad/blobs.ts';
import { memoBlobUri } from '../../src/context/memo-pad/index.ts';
import { pathExists } from '../helpers.ts';
import type { MemoFixture } from './fixtures.ts';
import { memoFixture, seedChat } from './fixtures.ts';

const fsHooks = vi.hoisted(() => ({
  beforeRemove: undefined as ((path: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((path: string) => Promise<void>) | undefined,
}));

// Pause filesystem boundaries while retaining real SQLite rows and file bytes.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      await fsHooks.beforeRemove?.(String(path));
      return actual.rm(path, options);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await fsHooks.beforeRename?.(String(args[1]));
      return actual.rename(...args);
    },
  };
});

const fixtures: MemoFixture[] = [];

afterEach(async () => {
  fsHooks.beforeRemove = undefined;
  fsHooks.beforeRename = undefined;
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

async function fixture(): Promise<MemoFixture> {
  const created = await memoFixture();
  fixtures.push(created);
  return created;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x02]);

test('identical bytes dedupe per Chat while another Chat always gets its own copy', async () => {
  const f = await fixture();
  const first = seedChat(f.store, 111n);
  const second = seedChat(f.store, 222n);

  const initial = await f.blobs.ingest(first.chatId, { bytes: PNG, mime: 'image/png' });
  expect(initial.created).toBe(true);
  expect(initial.blob.storagePath.startsWith(`${first.chatId}`)).toBe(true);

  const duplicate = await f.blobs.ingest(first.chatId, { bytes: PNG, mime: 'image/png' });
  expect(duplicate.created).toBe(false);
  expect(duplicate.blob.id).toBe(initial.blob.id);
  expect(duplicate.blob.storagePath).toBe(initial.blob.storagePath);

  const otherChat = await f.blobs.ingest(second.chatId, { bytes: PNG, mime: 'image/png' });
  expect(otherChat.created).toBe(true);
  expect(otherChat.blob.id).not.toBe(initial.blob.id);
  expect(otherChat.blob.storagePath.startsWith(`${second.chatId}`)).toBe(true);
  expect(Buffer.from(await f.blobs.content(otherChat.blob))).toEqual(Buffer.from(PNG));
  expect(f.blobs.get(initial.blob.id, second.chatId)).toBeUndefined();
  expect(f.blobs.getUnscoped(initial.blob.id)?.chatId).toBe(first.chatId);
});

test('a storage path outside the blob root is rejected', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const blob = {
    id: `blb_${'0'.repeat(32)}`,
    chatId: chat.chatId,
    sha256: 'sha',
    mime: 'image/png',
    byteSize: 1,
    storagePath: '../escape.png',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  expect(() => f.blobs.absolutePath(blob)).toThrow('Memo blob path escapes the blob root');
});

test('a detail change removes only blobs no remaining detail references', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const shared = await f.blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  const orphan = await f.blobs.ingest(chat.chatId, { bytes: JPEG, mime: 'image/jpeg' });

  const edited = f.memoPad.create(chat.chatId, {
    summary: 'edited',
    detail: `![shared](pwblob://${shared.blob.id}) and an orphan`,
  });
  const keeper = f.memoPad.create(chat.chatId, {
    summary: 'keeper',
    detail: `![shared](pwblob://${shared.blob.id})`,
  });
  // The edit replaced a detail that referenced both blobs; the keeper still
  // references the shared one, so only the orphan is unreferenced now.
  expect(
    await f.blobs.cleanupAfterDetailChange(
      chat.chatId,
      `${memoBlobUri(shared.blob.id)} ${memoBlobUri(orphan.blob.id)}`,
    ),
  ).toBe(1);
  expect(f.blobs.get(shared.blob.id, chat.chatId)).toBeDefined();
  expect(await pathExists(f.blobs.absolutePath(shared.blob))).toBe(true);
  expect(f.blobs.get(orphan.blob.id, chat.chatId)).toBeUndefined();
  expect(await pathExists(f.blobs.absolutePath(orphan.blob))).toBe(false);
  expect(f.memoPad.get(edited.id, chat.chatId)?.detail).toContain(memoBlobUri(shared.blob.id));
  expect(f.memoPad.get(keeper.id, chat.chatId)).toBeDefined();
});

test('sweep removes orphan rows and their files, globally or for one Chat', async () => {
  const f = await fixture();
  const first = seedChat(f.store, 111n);
  const second = seedChat(f.store, 222n);
  const used = await f.blobs.ingest(first.chatId, { bytes: PNG, mime: 'image/png' });
  const firstOrphan = await f.blobs.ingest(first.chatId, { bytes: JPEG, mime: 'image/jpeg' });
  const secondOrphan = await f.blobs.ingest(second.chatId, { bytes: new Uint8Array([9, 9, 9]), mime: 'image/png' });
  f.memoPad.create(first.chatId, {
    summary: 'uses the blob',
    detail: `![image](pwblob://${used.blob.id})`,
  });

  expect(await f.blobs.sweep(first.chatId, new Date(), 0)).toBe(1);
  expect(f.blobs.get(firstOrphan.blob.id, first.chatId)).toBeUndefined();
  expect(await pathExists(f.blobs.absolutePath(firstOrphan.blob))).toBe(false);
  expect(f.blobs.get(used.blob.id, first.chatId)).toBeDefined();
  expect(f.blobs.get(secondOrphan.blob.id, second.chatId)).toBeDefined();

  expect(await f.blobs.sweep(null, new Date(), 0)).toBe(1);
  expect(f.blobs.get(secondOrphan.blob.id, second.chatId)).toBeUndefined();
  expect(await pathExists(f.blobs.absolutePath(secondOrphan.blob))).toBe(false);
});

test('deleteChatFiles removes the files but leaves the rows to the chats cascade', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const stored = await f.blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  expect(await pathExists(f.blobs.absolutePath(stored.blob))).toBe(true);

  await f.blobs.deleteChatFiles(chat.chatId);
  expect(await pathExists(f.blobs.absolutePath(stored.blob))).toBe(false);
  expect(f.blobs.get(stored.blob.id, chat.chatId)).toBeDefined();
});

test('sweep leaves a freshly saved blob alone until the grace window passes', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const stored = await f.blobs.ingest(chat.chatId, { bytes: new Uint8Array([7, 8, 9]), mime: 'image/png' });

  expect(await f.blobs.sweep(chat.chatId)).toBe(0);
  expect(f.blobs.get(stored.blob.id, chat.chatId)).toBeDefined();
  expect(await f.blobs.sweep(chat.chatId, new Date(Date.now() + 11 * 60_000))).toBe(1);
  expect(f.blobs.get(stored.blob.id, chat.chatId)).toBeUndefined();
});

test.each([null, 'chat'] as const)('sweep rechecks a later candidate referenced during removal (%s)', async (scope) => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const blobs = new MemoBlobStore({ orm: f.store.orm, root: f.blobRoot, now: () => createdAt });
  const saved = [
    await blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' }),
    await blobs.ingest(chat.chatId, { bytes: JPEG, mime: 'image/jpeg' }),
  ];
  const removing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fsHooks.beforeRemove = async () => {
    removing.resolve();
    await resume.promise;
  };
  const sweep = blobs.sweep(scope === null ? null : chat.chatId, new Date(createdAt.getTime() + 11 * 60_000));
  await removing.promise;
  const survivor = saved.find(({ blob }) => blobs.get(blob.id, chat.chatId) !== undefined);
  try {
    expect(survivor).toBeDefined();
    f.memoPad.create(chat.chatId, {
      summary: 'reference added while another file is being removed',
      detail: memoBlobUri(survivor!.blob.id),
    });
  } finally {
    resume.resolve();
    await sweep;
  }
  expect(await sweep).toBe(1);
  expect(blobs.get(survivor!.blob.id, chat.chatId)).toEqual(survivor!.blob);
  expect(Buffer.from(await blobs.content(survivor!.blob))).toEqual(Buffer.from(survivor === saved[0] ? PNG : JPEG));
  const removed = saved.find((savedBlob) => savedBlob !== survivor)!;
  expect(await pathExists(blobs.absolutePath(removed.blob))).toBe(false);
});

test('reusing an old orphan renews a full grace window without changing its creation time', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  let now = new Date('2026-01-01T00:00:00.000Z');
  const blobs = new MemoBlobStore({ orm: f.store.orm, root: f.blobRoot, now: () => now });
  const original = await blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  now = new Date(now.getTime() + 11 * 60_000);
  const reused = await blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  expect(reused).toEqual({ blob: original.blob, created: false });

  expect(await blobs.sweep(chat.chatId, now)).toBe(0);
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000))).toBe(0);
  expect(blobs.get(original.blob.id, chat.chatId)).toEqual(original.blob);
  expect(Buffer.from(await blobs.content(original.blob))).toEqual(Buffer.from(PNG));
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000 + 1))).toBe(1);
  expect(blobs.get(original.blob.id, chat.chatId)).toBeUndefined();
  expect(await pathExists(blobs.absolutePath(original.blob))).toBe(false);
});

test.each([null, 'chat'] as const)('sweep rechecks a later candidate reused during removal (%s)', async (scope) => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  let now = new Date('2026-01-01T00:00:00.000Z');
  const blobs = new MemoBlobStore({ orm: f.store.orm, root: f.blobRoot, now: () => now });
  const saved = [
    await blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' }),
    await blobs.ingest(chat.chatId, { bytes: JPEG, mime: 'image/jpeg' }),
  ];
  now = new Date(now.getTime() + 11 * 60_000);
  const removing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  fsHooks.beforeRemove = async () => {
    removing.resolve();
    await resume.promise;
  };
  const sweep = blobs.sweep(scope === null ? null : chat.chatId, now);
  await removing.promise;
  const survivor = saved.find(({ blob }) => blobs.get(blob.id, chat.chatId) !== undefined);
  const bytes = survivor === saved[0] ? PNG : JPEG;
  try {
    expect(survivor).toBeDefined();
    const reused = await blobs.ingest(chat.chatId, { bytes, mime: survivor!.blob.mime });
    expect(reused).toEqual({ blob: survivor!.blob, created: false });
  } finally {
    resume.resolve();
    await sweep;
  }
  expect(await sweep).toBe(1);
  expect(blobs.get(survivor!.blob.id, chat.chatId)).toEqual(survivor!.blob);
  expect(Buffer.from(await blobs.content(survivor!.blob))).toEqual(Buffer.from(bytes));
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000))).toBe(0);
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000 + 1))).toBe(1);
  expect(await pathExists(blobs.absolutePath(survivor!.blob))).toBe(false);
});

test('a concurrent ingest winner is protected before cleanup and receives full grace on return', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  let now = new Date('2026-01-01T00:00:00.000Z');
  const blobs = new MemoBlobStore({ orm: f.store.orm, root: f.blobRoot, now: () => now });
  const renaming = Promise.withResolvers<string>();
  const resumeRename = Promise.withResolvers<void>();
  fsHooks.beforeRename = async (path) => {
    fsHooks.beforeRename = undefined;
    renaming.resolve(path);
    await resumeRename.promise;
  };
  const pending = blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  const losingPath = await renaming.promise;
  const winner = await blobs.ingest(chat.chatId, { bytes: PNG, mime: 'image/png' });
  now = new Date(now.getTime() + 11 * 60_000);
  const removing = Promise.withResolvers<void>();
  const resumeRemove = Promise.withResolvers<void>();
  fsHooks.beforeRemove = async (path) => {
    if (path === losingPath) {
      removing.resolve();
      await resumeRemove.promise;
    }
  };
  resumeRename.resolve();
  await removing.promise;
  try {
    expect(await blobs.sweep(chat.chatId, now)).toBe(0);
    expect(blobs.get(winner.blob.id, chat.chatId)).toEqual(winner.blob);
    expect(Buffer.from(await blobs.content(winner.blob))).toEqual(Buffer.from(PNG));
    now = new Date(now.getTime() + 9 * 60_000);
  } finally {
    resumeRemove.resolve();
    await pending;
  }
  expect(await pending).toEqual({ blob: winner.blob, created: false });
  expect(await pathExists(losingPath)).toBe(false);
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000))).toBe(0);
  expect(blobs.get(winner.blob.id, chat.chatId)).toEqual(winner.blob);
  expect(Buffer.from(await blobs.content(winner.blob))).toEqual(Buffer.from(PNG));
  expect(await blobs.sweep(chat.chatId, new Date(now.getTime() + 10 * 60_000 + 1))).toBe(1);
  expect(await pathExists(blobs.absolutePath(winner.blob))).toBe(false);
});
