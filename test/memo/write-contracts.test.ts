import { afterEach, expect, test, vi } from 'vitest';
import Type from 'typebox';
import { capability, createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import {
  MEMO_DETAIL_MAX_LENGTH,
  MEMO_SUMMARY_MAX_LENGTH,
  MEMO_TTL_MAX_SECONDS,
  MEMO_WRITE_INPUT_MAX_BYTES,
} from '../../src/context/memo-pad/index.ts';
import { createMemoReadTools, createMemoWriteTools } from '../../src/context/memo-pad/tools/index.ts';
import { updateMemory } from '../../src/ingress/admin/memory.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import {
  auditRows,
  type MemoFixture,
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
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

async function setup() {
  const f = await memoFixture();
  fixtures.push(f);
  const chat = seedChat(f.store, 123_456_789n);
  const invocationId = seedInvocation(f.store, chat.conversationId);
  const context = seedInvocationContext(chat, invocationId);
  const env = memoToolEnvironment(f, context);
  const read = toolNamed(createMemoReadTools(env), 'read_memory');
  const writeTools = createMemoWriteTools(env);
  const execute = createExecuteTool({
    audit: createToolAudit(f.store, invocationId),
    capabilities: writeTools.map((tool) =>
      capability(tool, true, tool.name === 'delete_memo' ? {} : { inputMaxBytes: MEMO_WRITE_INPUT_MAX_BYTES }),
    ),
  });
  return { f, chat, invocationId, context, read, execute, writeTools };
}

test.each([0, -1_000])('same/backward clock Admin edits invalidate reads (%i ms)', async (offset) => {
  const { f, chat, invocationId, context, read, writeTools } = await setup();
  const now = new Date('2026-01-01T00:00:00.000Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const entry = f.memoPad.create(chat.chatId, { summary: 'note', detail: 'original', ttlSeconds: 3_600 });
  await runTool(read, 'read-original', { id: entry.id });
  vi.setSystemTime(new Date(now.getTime() + offset));
  updateMemory(f.store.orm, entry.id, { detail: 'unread Admin detail' });
  const updated = f.memoPad.get(entry.id, chat.chatId);
  expect(updated?.updatedAt).toBe('2026-01-01T00:00:00.001Z');
  expect(updated?.expiresAt).toBe(entry.expiresAt);
  expect(f.memoPad.state(chat.chatId)[0]?.updatedAt).toBe(updated?.updatedAt);
  expect(context.memoReads.isRead(entry.id, updated!.updatedAt)).toBe(false);
  const update = toolNamed(writeTools, 'update_memo');
  await expect(runTool(update, 'stale-update', { id: entry.id, detail: 'overwrite' })).rejects.toThrow('read it again');
  expect(f.memoPad.get(entry.id, chat.chatId)?.detail).toBe('unread Admin detail');
  await runTool(read, 'read-admin', { id: entry.id });
  await runTool(update, 'fresh-update', { id: entry.id, detail: 'read then updated' });
  expect(f.memoPad.get(entry.id, chat.chatId)?.updatedAt).toBe('2026-01-01T00:00:00.002Z');
  expect(context.memoReads.isRead(entry.id, updated!.updatedAt)).toBe(false);
  await expect(runTool(update, 'second-update', { id: entry.id, detail: 'without rereading' })).rejects.toThrow(
    'Read this memory',
  );
  expect(f.memoPad.get(entry.id, chat.chatId)?.detail).toBe('read then updated');
  await runTool(read, 'read-own-update', { id: entry.id });
  await runTool(update, 'reread-update', { id: entry.id, detail: 'second authorized update' });
  expect(f.memoPad.get(entry.id, chat.chatId)?.updatedAt).toBe('2026-01-01T00:00:00.003Z');
  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'read-original', toolName: 'read_memory', state: 'success', errorCode: null },
    { toolCallId: 'stale-update', toolName: 'update_memo', state: 'error', errorCode: 'memo_not_read' },
    { toolCallId: 'read-admin', toolName: 'read_memory', state: 'success', errorCode: null },
    { toolCallId: 'fresh-update', toolName: 'update_memo', state: 'success', errorCode: null },
    { toolCallId: 'second-update', toolName: 'update_memo', state: 'error', errorCode: 'memo_not_read' },
    { toolCallId: 'read-own-update', toolName: 'read_memory', state: 'success', errorCode: null },
    { toolCallId: 'reread-update', toolName: 'update_memo', state: 'success', errorCode: null },
  ]);
});

for (const [label, character] of [
  ['ASCII', 'a'],
  ['UTF-8', '汉'],
  ['escaped', '\u0001'],
] as const) {
  test(`execute accepts maximum Memo add/update detail and summary: ${label}`, async () => {
    const { f, chat, invocationId, read, execute } = await setup();
    const summary = character.repeat(MEMO_SUMMARY_MAX_LENGTH);
    const detail = character.repeat(MEMO_DETAIL_MAX_LENGTH);
    await runTool(execute, 'add', {
      action: 'call',
      tool: 'add_memo',
      input: { summary, detail, ttl_seconds: MEMO_TTL_MAX_SECONDS },
    });
    const entry = f.memoPad.listActive(chat.chatId)[0]!;
    expect(entry).toMatchObject({ summary, detail });
    await runTool(read, 'read', { id: entry.id });
    const updatedDetail = `${detail.slice(0, -1)}z`;
    await runTool(execute, 'update', {
      action: 'call',
      tool: 'update_memo',
      input: { id: entry.id, summary, detail: updatedDetail, ttl_seconds: MEMO_TTL_MAX_SECONDS },
    });
    expect(f.memoPad.get(entry.id, chat.chatId)?.detail).toBe(updatedDetail);
    expect(auditRows(f.store, invocationId)).toEqual([
      { toolCallId: 'add', toolName: 'execute', state: 'success', errorCode: null },
      { toolCallId: 'add:add_memo', toolName: 'add_memo', state: 'success', errorCode: null },
      { toolCallId: 'read', toolName: 'read_memory', state: 'success', errorCode: null },
      { toolCallId: 'update', toolName: 'execute', state: 'success', errorCode: null },
      { toolCallId: 'update:update_memo', toolName: 'update_memo', state: 'success', errorCode: null },
    ]);
  });
}

test('Memo schema and byte limits reject excessive inputs without writing; other capabilities keep 32 KiB', async () => {
  const { f, chat, invocationId, execute } = await setup();
  await expect(
    runTool(execute, 'schema-limit', {
      action: 'call',
      tool: 'add_memo',
      input: { summary: 'large', detail: 'a'.repeat(MEMO_DETAIL_MAX_LENGTH + 1) },
    }),
  ).rejects.toThrow('does not match the schema');
  await expect(
    runTool(execute, 'byte-limit', {
      action: 'call',
      tool: 'add_memo',
      input: { summary: 'large', detail: 'a'.repeat(MEMO_WRITE_INPUT_MAX_BYTES) },
    }),
  ).rejects.toThrow('exceeds');
  const unrelated = createExecuteTool({
    audit: createToolAudit(f.store, invocationId),
    capabilities: [
      capability(
        {
          name: 'other',
          label: 'Other capability',
          description: 'Unrelated input policy',
          parameters: Type.Object({ detail: Type.String() }),
          execute: async () => {
            throw new Error('oversized input must not dispatch');
          },
        },
        false,
      ),
    ],
  });
  await expect(
    runTool(unrelated, 'default-limit', {
      action: 'call',
      tool: 'other',
      input: { detail: 'a'.repeat(32_768) },
    }),
  ).rejects.toThrow('exceeds 32 KiB');
  expect(f.memoPad.listActive(chat.chatId)).toEqual([]);
  expect(auditRows(f.store, invocationId)).toEqual([
    { toolCallId: 'schema-limit', toolName: 'execute', state: 'error', errorCode: 'invalid_arguments' },
    { toolCallId: 'byte-limit', toolName: 'execute', state: 'error', errorCode: 'arguments_too_large' },
    { toolCallId: 'default-limit', toolName: 'execute', state: 'error', errorCode: 'arguments_too_large' },
  ]);
});
