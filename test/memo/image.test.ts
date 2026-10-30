import type * as fs from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoBlobStore } from '../../src/context/memo-pad/blobs.ts';
import { createSaveMemoImageTool } from '../../src/context/memo-pad/tools/image.ts';
import type { MemoToolEnvironment } from '../../src/context/memo-pad/tools/shared.ts';
import { unavailableCapabilities } from '../../src/platform/invocation-context.ts';
import { memoBlobs } from '../../src/store/schema/index.ts';
import { pathExists } from '../helpers.ts';
import {
  auditRows,
  type MemoFixture,
  memoFixture,
  memoToolEnvironment,
  seedChat,
  seedInvocation,
  seedInvocationContext,
} from './fixtures.ts';

type Boundary = 'mkdir' | 'write' | 'rename' | 'remove';
type Revocation = 'removal' | 'abort';

const fsHooks = vi.hoisted(() => ({
  pause: undefined as ((boundary: Boundary, path: string) => Promise<void>) | undefined,
}));

// Gate real filesystem work so revocation occurs at deterministic await boundaries.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await fsHooks.pause?.('mkdir', String(args[0]));
      return result;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      await fsHooks.pause?.('write', String(args[0]));
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      await fsHooks.pause?.('rename', String(args[1]));
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await fsHooks.pause?.('remove', String(args[0]));
      await actual.rm(...args);
    },
  };
});

const fixtures: MemoFixture[] = [];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const IMAGE = { base64: Buffer.from(PNG).toString('base64'), mime: 'image/png' };
const REMOVED = 'This Chat is no longer configured; memory writes are refused';
const CANCELLED = 'image save cancelled';

function pauseFilesystem(boundary: Boundary, onlyPath?: string) {
  const entered = Promise.withResolvers<string>();
  const resume = Promise.withResolvers<void>();
  fsHooks.pause = async (current, path) => {
    if (current !== boundary || (onlyPath !== undefined && onlyPath !== path)) {
      return;
    }
    fsHooks.pause = undefined;
    entered.resolve(path);
    await resume.promise;
  };
  return { entered: entered.promise, resume: resume.resolve };
}

function revoke(f: MemoFixture, controller: AbortController, mode: Revocation): void {
  if (mode === 'abort') {
    controller.abort(new Error(CANCELLED));
    return;
  }
  const current = f.configStore.current();
  f.configStore.publish({
    config: { ...current.config, telegram: { ...current.config.telegram, chats: [] } },
    hash: current.hash,
    models: current.models,
    visionModel: current.visionModel,
  });
}

function expectedError(mode: Revocation): string {
  return mode === 'abort' ? CANCELLED : REMOVED;
}

async function blobFiles(f: MemoFixture): Promise<string[]> {
  if (!(await pathExists(f.blobRoot))) {
    return [];
  }
  return (await readdir(f.blobRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function setup(prepareImage: MemoToolEnvironment['prepareImage'] = async () => IMAGE) {
  const f = await memoFixture();
  fixtures.push(f);
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const clock = { now: new Date('2026-01-01T00:00:00.000Z') };
  const blobs = new MemoBlobStore({ orm: f.store.orm, root: f.blobRoot, now: () => clock.now });
  const save = createSaveMemoImageTool({
    ...memoToolEnvironment(f, context),
    blobs,
    capabilities: {
      ...unavailableCapabilities(),
      resolveMedia: (ref) => (ref === 'img_one' ? 42n : undefined),
    },
    prepareImage,
  });
  return { f, chat, invocationId, clock, blobs, save, controller: new AbortController() };
}

function expectErrorAudit(f: MemoFixture, invocationId: bigint, errorCode = 'memo_blob_error'): void {
  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'save-image', toolName: 'save_memo_image', state: 'error', errorCode },
  ]);
}

afterEach(async () => {
  fsHooks.pause = undefined;
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

test.each(['removal', 'abort'] as const)('save refuses %s before image preparation', async (mode) => {
  const prepare = vi.fn(async () => IMAGE);
  const { f, invocationId, save, controller } = await setup(prepare);
  revoke(f, controller, mode);

  await expect(save.execute('save-image', { image_ref: 'img_one' }, controller.signal)).rejects.toThrow(
    expectedError(mode),
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual([]);
  expect(await blobFiles(f)).toEqual([]);
  expectErrorAudit(f, invocationId, mode === 'removal' ? 'chat_removed' : 'memo_blob_error');
});

test.each([
  ['removal', false],
  ['abort', false],
  ['removal', true],
  ['abort', true],
] as const)('save refuses %s during preparation without creating or renewing blobs (reuse=%s)', async (mode, reuse) => {
  const preparing = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const { f, chat, invocationId, clock, blobs, save, controller } = await setup(async () => {
    preparing.resolve();
    await resume.promise;
    return IMAGE;
  });
  if (reuse) {
    await blobs.ingest(chat.chatId, { bytes: PNG, mime: IMAGE.mime });
  }
  const originalRows = f.store.orm.select().from(memoBlobs).all();
  const originalFiles = await blobFiles(f);
  clock.now = new Date(clock.now.getTime() + 60_000);
  const pending = save.execute('save-image', { image_ref: 'img_one' }, controller.signal);
  await preparing.promise;
  try {
    revoke(f, controller, mode);
  } finally {
    resume.resolve();
  }

  await expect(pending).rejects.toThrow(expectedError(mode));
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual(originalRows);
  expect(await blobFiles(f)).toEqual(originalFiles);
  expectErrorAudit(f, invocationId);
});

test.each([
  ['removal', 'mkdir'],
  ['abort', 'mkdir'],
  ['removal', 'write'],
  ['abort', 'write'],
  ['removal', 'rename'],
  ['abort', 'rename'],
] as const)('save refuses %s after %s and removes its own unfinished files', async (mode, boundary) => {
  const { f, invocationId, save, controller } = await setup();
  const gate = pauseFilesystem(boundary);
  const pending = save.execute('save-image', { image_ref: 'img_one' }, controller.signal);
  await gate.entered;
  try {
    revoke(f, controller, mode);
  } finally {
    gate.resume();
  }

  await expect(pending).rejects.toThrow(expectedError(mode));
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual([]);
  expect(await blobFiles(f)).toEqual([]);
  expectErrorAudit(f, invocationId);
});

test.each(['removal', 'abort'] as const)('save refuses %s before touching a concurrent dedup winner', async (mode) => {
  const { f, chat, invocationId, clock, blobs, save, controller } = await setup();
  const gate = pauseFilesystem('rename');
  const pending = save.execute('save-image', { image_ref: 'img_one' }, controller.signal);
  const losingPath = await gate.entered;
  const winner = await blobs.ingest(chat.chatId, { bytes: PNG, mime: IMAGE.mime });
  const winnerRows = f.store.orm.select().from(memoBlobs).all();
  try {
    clock.now = new Date(clock.now.getTime() + 60_000);
    revoke(f, controller, mode);
  } finally {
    gate.resume();
  }

  await expect(pending).rejects.toThrow(expectedError(mode));
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual(winnerRows);
  expect(await pathExists(losingPath)).toBe(false);
  expect(await blobFiles(f)).toEqual([blobs.absolutePath(winner.blob)]);
  expect(Buffer.from(await blobs.content(winner.blob))).toEqual(Buffer.from(PNG));
  expectErrorAudit(f, invocationId);
});

test.each(['removal', 'abort'] as const)(
  'save refuses %s during duplicate cleanup without renewing the winner afterward',
  async (mode) => {
    const { f, chat, invocationId, clock, blobs, save, controller } = await setup();
    const renameGate = pauseFilesystem('rename');
    const pending = save.execute('save-image', { image_ref: 'img_one' }, controller.signal);
    const losingPath = await renameGate.entered;
    const winner = await blobs.ingest(chat.chatId, { bytes: PNG, mime: IMAGE.mime });
    clock.now = new Date(clock.now.getTime() + 11 * 60_000);
    const removeGate = pauseFilesystem('remove', losingPath);
    renameGate.resume();
    await removeGate.entered;
    const protectedRows = f.store.orm.select().from(memoBlobs).all();
    try {
      expect(protectedRows[0]?.lastSavedAt).toBe(clock.now.toISOString());
      expect(await blobs.sweep(chat.chatId, clock.now)).toBe(0);
      clock.now = new Date(clock.now.getTime() + 60_000);
      revoke(f, controller, mode);
    } finally {
      removeGate.resume();
    }

    await expect(pending).rejects.toThrow(expectedError(mode));
    expect(f.store.orm.select().from(memoBlobs).all()).toEqual(protectedRows);
    expect(await pathExists(losingPath)).toBe(false);
    expect(await blobFiles(f)).toEqual([blobs.absolutePath(winner.blob)]);
    expect(Buffer.from(await blobs.content(winner.blob))).toEqual(Buffer.from(PNG));
    expectErrorAudit(f, invocationId);
  },
);

test('storage refuses a revoked dedup reuse before changing last_saved_at', async () => {
  const { f, chat, clock, blobs, controller } = await setup();
  const winner = await blobs.ingest(chat.chatId, { bytes: PNG, mime: IMAGE.mime });
  const originalRows = f.store.orm.select().from(memoBlobs).all();
  clock.now = new Date(clock.now.getTime() + 60_000);
  controller.abort(new Error(CANCELLED));

  await expect(
    blobs.ingest(chat.chatId, {
      bytes: PNG,
      mime: IMAGE.mime,
      assertWritable: () => controller.signal.throwIfAborted(),
    }),
  ).rejects.toThrow(CANCELLED);
  expect(f.store.orm.select().from(memoBlobs).all()).toEqual(originalRows);
  expect(await blobFiles(f)).toEqual([blobs.absolutePath(winner.blob)]);
  expect(Buffer.from(await blobs.content(winner.blob))).toEqual(Buffer.from(PNG));
});
