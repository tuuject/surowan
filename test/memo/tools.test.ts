import { sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import {
  createMemoReadTools,
  createMemoWriteTools,
  createSaveMemoImageTool,
} from '../../src/context/memo-pad/tools/index.ts';
import { parseMemoBlobUri } from '../../src/context/memo-pad/index.ts';
import { unavailableCapabilities } from '../../src/platform/invocation-context.ts';
import { pathExists } from '../helpers.ts';
import type { InvocationContextState } from '../../src/platform/invocation-context.ts';
import type { MemoFixture } from './fixtures.ts';
import {
  auditRows,
  memoFixture,
  memoToolEnvironment,
  runTool,
  seedChat,
  seedInvocation,
  seedInvocationContext,
  toolNamed,
} from './fixtures.ts';

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

function tools(f: MemoFixture, context: InvocationContextState) {
  const environment = memoToolEnvironment(f, context);
  return [...createMemoReadTools(environment), ...createMemoWriteTools(environment)];
}

function removeAllChats(f: MemoFixture): void {
  const current = f.configStore.current();
  f.configStore.publish({
    config: { ...current.config, telegram: { ...current.config.telegram, chats: [] } },
    hash: current.hash,
    models: current.models,
    visionModel: current.visionModel,
  });
}

test('read_memory returns the detail and marks the revision as read for update_memo', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const entry = f.memoPad.create(chat.chatId, {
    summary: 'owner likes cats',
    detail: 'The owner has two cats, Miso and Tofu.',
  });
  const available = tools(f, context);

  const read = await runTool(toolNamed(available, 'read_memory'), 'call-read', { id: entry.id });
  expect(read.text).toContain('The owner has two cats, Miso and Tofu.');
  expect(read.details).toEqual({ id: entry.id });
  expect(context.memoReads.isRead(entry.id, entry.updatedAt)).toBe(true);

  const update = await runTool(toolNamed(available, 'update_memo'), 'call-update', {
    id: entry.id,
    summary: 'owner likes two cats',
  });
  expect(update.text).toContain('Updated');
  expect(f.memoPad.get(entry.id, chat.chatId)?.summary).toBe('owner likes two cats');
  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'call-read', toolName: 'read_memory', state: 'success', errorCode: null },
    { toolCallId: 'call-update', toolName: 'update_memo', state: 'success', errorCode: null },
  ]);
});

test('update_memo rejects a write without a read and after the revision changed', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 'before', detail: 'detail' });
  const available = tools(f, context);
  const updateTool = toolNamed(available, 'update_memo');

  await expect(runTool(updateTool, 'call-unread', { id: entry.id, summary: 'nope' })).rejects.toThrow(
    'Read this memory with read_memory before modifying it',
  );
  expect(f.memoPad.get(entry.id, chat.chatId)?.summary).toBe('before');

  await runTool(toolNamed(available, 'read_memory'), 'call-read', { id: entry.id });
  expect(context.memoReads.isRead(entry.id, entry.updatedAt)).toBe(true);

  // An Admin-side write bumps updated_at without updating this invocation's read marker.
  f.store.orm.run(sql`UPDATE memo_pad_entries SET updated_at = ${'2026-07-01T00:00:00.000Z'} WHERE id = ${entry.id}`);
  await expect(runTool(updateTool, 'call-stale', { id: entry.id, summary: 'stale write' })).rejects.toThrow(
    'Read this memory with read_memory before modifying it',
  );
  expect(f.memoPad.get(entry.id, chat.chatId)?.summary).toBe('before');

  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'call-unread', toolName: 'update_memo', state: 'error', errorCode: 'memo_not_read' },
    { toolCallId: 'call-read', toolName: 'read_memory', state: 'success', errorCode: null },
    { toolCallId: 'call-stale', toolName: 'update_memo', state: 'error', errorCode: 'memo_not_read' },
  ]);
});

test('delete_memo works without a prior read and is idempotent', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 'forget me', detail: 'detail' });
  const available = tools(f, context);
  const deleteTool = toolNamed(available, 'delete_memo');
  expect(context.memoReads.isRead(entry.id, entry.updatedAt)).toBe(false);

  const first = await runTool(deleteTool, 'call-delete', { id: entry.id });
  expect(first.details).toEqual({ id: entry.id, deleted: true });
  expect(f.memoPad.get(entry.id, chat.chatId)).toBeUndefined();

  const second = await runTool(deleteTool, 'call-delete-again', { id: entry.id });
  expect(second.details).toEqual({ id: entry.id, deleted: false });

  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'call-delete', toolName: 'delete_memo', state: 'success', errorCode: null },
    { toolCallId: 'call-delete-again', toolName: 'delete_memo', state: 'success', errorCode: null },
  ]);
});

test('add_memo refuses writes once the Telegram Chat left the configuration and audits the refusal', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const addTool = toolNamed(createMemoWriteTools(memoToolEnvironment(f, context)), 'add_memo');

  const added = await runTool(addTool, 'call-add', { summary: 'note', detail: 'body' });
  expect(added.text).toContain('Saved mem_');

  removeAllChats(f);
  await expect(runTool(addTool, 'call-removed', { summary: 'late', detail: 'body' })).rejects.toThrow(
    'This Chat is no longer configured; memory writes are refused',
  );
  expect(f.memoPad.listActive(chat.chatId)).toHaveLength(1);

  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'call-add', toolName: 'add_memo', state: 'success', errorCode: null },
    { toolCallId: 'call-removed', toolName: 'add_memo', state: 'error', errorCode: 'chat_removed' },
  ]);
});

test('save_memo_image copies an authorized image into a Chat-owned blob', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const environment = memoToolEnvironment(f, context);
  const save = createSaveMemoImageTool({
    ...environment,
    capabilities: {
      ...unavailableCapabilities(),
      resolveMedia: (ref) => (ref === 'img_one' ? 42n : undefined),
    },
    prepareImage: async () => ({ base64: Buffer.from([137, 80, 78, 71]).toString('base64'), mime: 'image/png' }),
  });

  const saved = await runTool(save, 'call-image', { image_ref: 'img_one' });
  const details = saved.details as { blob_uri: string };
  const blobId = parseMemoBlobUri(details.blob_uri);
  expect(blobId).toBeDefined();
  const blob = f.blobs.get(blobId!, chat.chatId);
  expect(blob).toBeDefined();
  expect(await pathExists(f.blobs.absolutePath(blob!))).toBe(true);

  await expect(runTool(save, 'call-image-denied', { image_ref: 'pwblob://blb_not_authorized' })).rejects.toThrow(
    'image_ref is not visible in this conversation context',
  );
  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'call-image', toolName: 'save_memo_image', state: 'success', errorCode: null },
    {
      toolCallId: 'call-image-denied',
      toolName: 'save_memo_image',
      state: 'error',
      errorCode: 'image_ref_not_authorized',
    },
  ]);
});

test('read_memory and update_memo treat an expired entry as missing while delete still works', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const entry = f.memoPad.create(chat.chatId, { summary: 'ephemeral', detail: 'detail', ttlSeconds: 3_600 });
  f.store.orm.run(
    sql`UPDATE memo_pad_entries
        SET created_at = ${'2019-01-01T00:00:00.000Z'}, expires_at = ${'2019-01-02T00:00:00.000Z'}
        WHERE id = ${entry.id}`,
  );
  const available = tools(f, context);

  await expect(runTool(toolNamed(available, 'read_memory'), 'call-read-expired', { id: entry.id })).rejects.toThrow(
    'Memory not found in this Chat',
  );
  await expect(
    runTool(toolNamed(available, 'update_memo'), 'call-update-expired', { id: entry.id, summary: 'nope' }),
  ).rejects.toThrow('Memory not found in this Chat');
  const deleted = await runTool(toolNamed(available, 'delete_memo'), 'call-delete-expired', { id: entry.id });
  expect(deleted.details).toEqual({ id: entry.id, deleted: true });
});

test('add_memo and update_memo apply ttl_seconds and null promotes to permanent', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const available = tools(f, context);

  const added = await runTool(toolNamed(available, 'add_memo'), 'call-add-ttl', {
    summary: 'temporary',
    detail: 'body',
    ttl_seconds: 3_600,
  });
  const addedDetails = added.details as { id: string; expires_at: string | null };
  expect(addedDetails.expires_at).not.toBeNull();
  expect(f.memoPad.get(addedDetails.id, chat.chatId)?.expiresAt).toBe(addedDetails.expires_at);

  await runTool(toolNamed(available, 'read_memory'), 'call-read-ttl', { id: addedDetails.id });
  const promoted = await runTool(toolNamed(available, 'update_memo'), 'call-promote', {
    id: addedDetails.id,
    ttl_seconds: null,
  });
  expect((promoted.details as { expires_at: string | null }).expires_at).toBeNull();
  expect(f.memoPad.get(addedDetails.id, chat.chatId)?.expiresAt).toBeNull();
});
