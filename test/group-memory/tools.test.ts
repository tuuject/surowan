import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { InvocationContextState } from '../../src/platform/invocation-context.ts';
import { createGroupMemoryReadTools } from '../../src/context/group-memory/tools/read.ts';
import { auditRows, runTool, seedInvocation, toolNamed } from '../memo/fixtures.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

function context(f: Awaited<ReturnType<typeof groupMemoryFixture>>, invocationId: bigint): InvocationContextState {
  return new InvocationContextState({
    invocationId,
    conversationId: f.conversationId,
    hostKind: 'telegram',
    chatId: f.telegramChatId,
    internalChatId: f.chatId,
    threadId: 0n,
    completion: null,
  });
}

test('search_group_memory returns summaries with ranges, then read_group_messages replays them', async () => {
  const f = await groupMemoryFixture();
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'Natu: eSIM 多少钱？',
      senderName: 'Natu',
      senderTelegramId: 11,
    });
    seedMessage(f.store, f, {
      telegramMessageId: 4114,
      date: new Date('2026-10-01T10:05:00.000Z'),
      text: 'tcdw: 大概 50 块',
      senderName: 'tcdw',
      senderTelegramId: 12,
    });
    seedMessage(f.store, f, {
      telegramMessageId: 4120,
      date: new Date('2026-10-01T10:06:00.000Z'),
      text: 'later noise',
      senderName: 'tcdw',
      senderTelegramId: 12,
    });
    f.store.orm.run(
      sql`INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, updated_at)
          VALUES (2, 'telegram', 987654321, 987654321, 'supergroup', '2026-01-01T00:00:00.000Z')`,
    );
    seedMessage(
      f.store,
      { chatId: 2n, conversationId: 0n },
      {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'other chat secret',
        senderName: 'Mallory',
        senderTelegramId: 13,
      },
    );
    f.groupMemory.commit(
      f.chatId,
      '2026-10-01',
      [{ summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 4005n, lastMessageId: 4114n }],
      4120n,
    );
    const invocationId = seedInvocation(f.store, f.conversationId);
    const tools = createGroupMemoryReadTools({
      store: f.store,
      configStore: f.configStore,
      context: context(f, invocationId),
    });

    const search = await runTool(toolNamed(tools, 'search_group_memory'), 'call-search', { date: '2026-10-01' });
    expect(search.text).toContain('Natu and tcdw discussed eSIM prices');
    expect(search.text).toContain('messages 4005-4114');
    expect(search.details).toEqual({ count: 1 });

    const range = await runTool(toolNamed(tools, 'read_group_messages'), 'call-range', {
      first_message_id: 4005,
      last_message_id: 4114,
    });
    expect(range.text).toContain('eSIM 多少钱');
    expect(range.text).toContain('大概 50 块');
    expect(range.text).not.toContain('later noise');
    expect(range.text).not.toContain('other chat secret');
    expect(range.text).toContain('<untrusted_group_messages');
    expect(range.details).toEqual({ count: 2 });

    const limited = await runTool(toolNamed(tools, 'read_group_messages'), 'call-limited', {
      first_message_id: 4005,
      last_message_id: 4114,
      limit: 1,
    });
    expect(limited.details).toEqual({ count: 1 });
    expect(limited.text).toContain('messages omitted; narrow the range');

    expect(auditRows(f.store, invocationId)).toEqual([
      { toolCallId: 'call-search', toolName: 'search_group_memory', state: 'success', errorCode: null },
      { toolCallId: 'call-range', toolName: 'read_group_messages', state: 'success', errorCode: null },
      { toolCallId: 'call-limited', toolName: 'read_group_messages', state: 'success', errorCode: null },
    ]);
  } finally {
    await f.close();
  }
});

test('read_group_messages rejects backwards and oversized ranges with an audit error', async () => {
  const f = await groupMemoryFixture();
  try {
    const invocationId = seedInvocation(f.store, f.conversationId);
    const tools = createGroupMemoryReadTools({
      store: f.store,
      configStore: f.configStore,
      context: context(f, invocationId),
    });
    const read = toolNamed(tools, 'read_group_messages');
    await expect(runTool(read, 'call-backwards', { first_message_id: 20, last_message_id: 10 })).rejects.toThrow(
      'first_message_id',
    );
    await expect(runTool(read, 'call-wide', { first_message_id: 1, last_message_id: 10_000 })).rejects.toThrow(
      'too wide',
    );
    expect(auditRows(f.store, invocationId)).toEqual([
      {
        toolCallId: 'call-backwards',
        toolName: 'read_group_messages',
        state: 'error',
        errorCode: 'group_memory_read_error',
      },
      {
        toolCallId: 'call-wide',
        toolName: 'read_group_messages',
        state: 'error',
        errorCode: 'group_memory_read_error',
      },
    ]);
  } finally {
    await f.close();
  }
});

test('the tools are absent when the Chat has not enabled group memory', async () => {
  const f = await groupMemoryFixture({ enabled: false });
  try {
    const invocationId = seedInvocation(f.store, f.conversationId);
    expect(
      createGroupMemoryReadTools({ store: f.store, configStore: f.configStore, context: context(f, invocationId) }),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
