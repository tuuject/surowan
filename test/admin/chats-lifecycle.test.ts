import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import type { InvocationHandler } from '../../src/orchestration/scheduler/index.ts';
import {
  buckets,
  chatMigrations,
  chats,
  conversations,
  invocations,
  longTasks,
  taskReceipts,
  toolCalls,
} from '../../src/store/schema/index.ts';
import { pathExists } from '../helpers.ts';
import { seedChat } from '../memo/fixtures.ts';

import { fixture, queue, slowHandler, useLifecycleCleanup } from './chats-lifecycle-fixtures.ts';

useLifecycleCleanup();

test('Admin delete waits for a run started during asynchronous configuration preparation', async () => {
  const run = slowHandler();
  const preparing = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  const f = await fixture(run.handler, {
    imageConfig: {
      prepare: async () => {
        preparing.resolve();
        await prepared.promise;
      },
      publish: () => undefined,
    },
  });
  const chat = seedChat(f.store, 123456789n);
  const id = queue(f, chat.conversationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 'retained until stopped', detail: 'detail' });
  const waiting = Promise.withResolvers<void>();
  const wait = f.scheduler.waitForInvocations.bind(f.scheduler);
  vi.spyOn(f.scheduler, 'waitForInvocations').mockImplementation((ids) => {
    const settled = wait(ids);
    waiting.resolve();
    return settled;
  });
  try {
    const deletion = f.remove(chat.telegramChatId);
    await preparing.promise;
    f.scheduler.start();
    await run.started.promise;
    prepared.resolve();
    await run.aborted.promise;
    await waiting.promise;
    expect(f.memoPad.get(entry.id, chat.chatId)).toBeDefined();
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('running');
    expect(f.store.orm.select().from(toolCalls).get()?.state).toBe('pending');
    run.release.resolve();
    expect((await deletion).status).toBe(200);
    expect(run.audited).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success', finishedAt: expect.any(String) }),
    );
    expect(f.store.orm.select().from(chats).all()).toEqual([]);
  } finally {
    prepared.resolve();
    run.release.resolve();
  }
});

test('timeout retains rows and final audit, and DELETE retries after config removal without undoing other edits', async () => {
  const run = slowHandler();
  const f = await fixture(run.handler);
  const chat = seedChat(f.store, 123456789n);
  const id = queue(f, chat.conversationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 'survives timeout', detail: 'detail' });
  const blob = await f.blobs.ingest(chat.chatId, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
  const wait = f.scheduler.waitForInvocations.bind(f.scheduler);
  vi.spyOn(f.scheduler, 'waitForInvocations').mockImplementation((ids) => wait(ids, 0));
  f.scheduler.start();
  await run.started.promise;
  try {
    const response = await f.remove(chat.telegramChatId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'chat_delete_pending' });
    expect(f.configStore.current().config.telegram.chats).toEqual([]);
    expect(f.memoPad.get(entry.id, chat.chatId)).toBeDefined();
    expect(await pathExists(f.blobs.absolutePath(blob.blob))).toBe(true);
    expect(f.store.orm.select().from(toolCalls).get()?.state).toBe('pending');
    expect((await f.reloader.writeAndApply([{ path: ['telegram', 'chats', 0], value: { id: 222 } }])).ok).toBe(true);
    run.release.resolve();
    expect(await wait([id])).toBe(true);
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()).toMatchObject({
      state: 'aborted',
      completionReason: 'chat_removed',
    });
    expect(f.store.orm.select().from(toolCalls).get()).toMatchObject({
      state: 'success',
      resultText: 'finished after abort',
    });
    expect((await f.remove(chat.telegramChatId)).status).toBe(200);
    expect(f.store.orm.select().from(chats).all()).toEqual([]);
    expect(await pathExists(f.blobs.absolutePath(blob.blob))).toBe(false);
    expect(f.configStore.current().config.telegram.chats.map((row) => row.id)).toEqual([222]);
  } finally {
    run.release.resolve();
  }
});

test('a migration alias re-added while deletion waits protects all stored data', async () => {
  const run = slowHandler();
  const f = await fixture(run.handler);
  const chat = seedChat(f.store, 123456789n);
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: chat.telegramChatId, newChatId: 222n, receivedAt: new Date().toISOString() })
    .run();
  queue(f, chat.conversationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 're-added', detail: 'detail' });
  const waiting = Promise.withResolvers<void>();
  const wait = f.scheduler.waitForInvocations.bind(f.scheduler);
  vi.spyOn(f.scheduler, 'waitForInvocations').mockImplementation((ids) => {
    const settled = wait(ids);
    waiting.resolve();
    return settled;
  });
  f.scheduler.start();
  await run.started.promise;
  try {
    const deletion = f.remove(chat.telegramChatId);
    await run.aborted.promise;
    await waiting.promise;
    expect((await f.reloader.writeAndApply([{ path: ['telegram', 'chats', 0], value: { id: 222 } }])).ok).toBe(true);
    run.release.resolve();
    const response = await deletion;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'chat_still_authorized' });
    expect(f.memoPad.get(entry.id, chat.chatId)).toBeDefined();
    expect(f.store.orm.select().from(chatMigrations).all()).toHaveLength(1);
    expect(f.store.orm.select().from(toolCalls).get()?.state).toBe('success');
  } finally {
    run.release.resolve();
  }
});

test('replacing old migration alias preserves authorized runs and tasks, true removal stops them and retains data', async () => {
  const run = slowHandler();
  const f = await fixture(run.handler);
  const old = seedChat(f.store, 123456789n);
  const next = seedChat(f.store, 222n);
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: old.telegramChatId, newChatId: next.telegramChatId, receivedAt: new Date().toISOString() })
    .run();
  const entry = f.memoPad.create(old.chatId, { summary: 'old history retained', detail: 'detail' });
  const blob = await f.blobs.ingest(old.chatId, { bytes: new Uint8Array([4, 5]), mime: 'image/png' });
  const id = queue(f, next.conversationId);
  const task = f.tasks.scoped('test', next.conversationId).create({ payload: { reminder: 'keep me' } });
  f.scheduler.start();
  await run.started.promise;
  const otherTopic = f.store.orm
    .insert(conversations)
    .values({
      chatId: next.chatId,
      messageThreadId: 12n,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning({ id: conversations.id })
    .get();
  if (otherTopic === undefined) {
    throw new Error('Missing queued topic');
  }
  const queuedId = queue(f, otherTopic.id);
  try {
    expect((await f.reloader.writeAndApply([{ path: ['telegram', 'chats', 0, 'id'], value: 222 }])).ok).toBe(true);
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('running');
    expect(f.store.orm.select().from(longTasks).where(eq(longTasks.id, task.taskId)).get()?.state).toBe('waiting');
    expect(f.forget).not.toHaveBeenCalledWith(next.conversationId);
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, queuedId)).get()?.state).toBe('queued');
    expect(f.memoPad.get(entry.id, old.chatId)).toBeDefined();
    expect((await f.reloader.writeAndApply([{ path: ['telegram', 'chats'], value: [] }])).ok).toBe(true);
    await run.aborted.promise;
    expect(f.store.orm.select().from(longTasks).where(eq(longTasks.id, task.taskId)).get()?.state).toBe('cancelled');
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, queuedId)).get()).toMatchObject({
      state: 'aborted',
      completionReason: 'chat_removed',
    });
    expect(f.store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, task.taskId)).get()).toMatchObject({
      state: 'suppressed',
      cancelReason: 'chat_removed',
    });
    expect(f.memoPad.get(entry.id, old.chatId)).toBeDefined();
    expect(await pathExists(f.blobs.absolutePath(blob.blob))).toBe(true);
    run.release.resolve();
    expect(await f.scheduler.waitForInvocations([id])).toBe(true);
    expect((await f.remove(next.telegramChatId)).status).toBe(200);
    expect(f.store.orm.select().from(chats).all()).toEqual([]);
    expect(f.memoPad.get(entry.id, old.chatId)).toBeUndefined();
    expect(await pathExists(f.blobs.absolutePath(blob.blob))).toBe(false);
  } finally {
    run.release.resolve();
  }
});

test('deleting one separately configured alias preserves the other alias data, task and active run', async () => {
  const run = slowHandler();
  const f = await fixture(run.handler, { transform: (config) => config.telegram.chats.push({ id: 222 }) });
  const next = seedChat(f.store, 222n);
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: 123456789n, newChatId: 222n, receivedAt: new Date().toISOString() })
    .run();
  const id = queue(f, next.conversationId);
  const task = f.tasks.scoped('test', next.conversationId).create({ payload: {} });
  const entry = f.memoPad.create(next.chatId, { summary: 'still authorized', detail: 'detail' });
  f.scheduler.start();
  await run.started.promise;
  try {
    const response = await f.remove(123456789n);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'chat_still_authorized' });
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('running');
    expect(f.store.orm.select().from(longTasks).where(eq(longTasks.id, task.taskId)).get()?.state).toBe('waiting');
    expect(f.memoPad.get(entry.id, next.chatId)).toBeDefined();
    run.release.resolve();
    expect(await f.scheduler.waitForInvocations([id])).toBe(true);
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('completed');
  } finally {
    run.release.resolve();
  }
});

test('already queued work cannot start after the live allowlist removes its Chat', async () => {
  const handler = vi.fn<InvocationHandler>(async () => ({ state: 'completed', reason: 'unexpected' }));
  const f = await fixture(() => handler);
  const chat = seedChat(f.store, 123456789n);
  const id = queue(f, chat.conversationId);
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: { ...current.config, telegram: { ...current.config.telegram, chats: [] } },
  });
  f.scheduler.start();
  expect(handler).not.toHaveBeenCalled();
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()).toMatchObject({
    state: 'aborted',
    completionReason: 'chat_removed',
  });
  expect(f.store.orm.select().from(buckets).get()).toMatchObject({ state: 'aborted', errorCode: 'chat_removed' });
});

test('explicit purge leaves an unrelated configured Chat and its waiting task intact', async () => {
  const f = await fixture(() => async () => ({ state: 'completed', reason: 'done' }), {
    transform: (config) => config.telegram.chats.push({ id: 222 }),
  });
  const removed = seedChat(f.store, 123456789n);
  const retained = seedChat(f.store, 222n);
  const entry = f.memoPad.create(retained.chatId, { summary: 'unrelated memory', detail: 'detail' });
  const task = f.tasks.scoped('test', retained.conversationId).create({ payload: {} });
  const blob = await f.blobs.ingest(retained.chatId, { bytes: new Uint8Array([9]), mime: 'image/png' });

  expect((await f.remove(removed.telegramChatId)).status).toBe(200);
  expect(f.store.orm.select({ id: chats.id }).from(chats).all()).toEqual([{ id: retained.chatId }]);
  expect(f.memoPad.get(entry.id, retained.chatId)).toBeDefined();
  expect(f.store.orm.select().from(longTasks).where(eq(longTasks.id, task.taskId)).get()?.state).toBe('waiting');
  expect(await pathExists(f.blobs.absolutePath(blob.blob))).toBe(true);
});
