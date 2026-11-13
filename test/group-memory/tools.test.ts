import { asc, eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { InvocationContextState } from '../../src/platform/invocation-context.ts';
import { createGroupMemoryReadTools } from '../../src/context/group-memory/tools/read.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
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
    f.groupMemory.record(f.chatId, '2026-10-01', [
      { summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 4005n, lastMessageId: 4114n },
    ]);
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

// Ways the zero-match nudge can fail: missing when keywords filtered a dated
// search to nothing; naming a date the model never gave; firing on a hit;
// telling a filterless search to "retry" the same query; or leaking into the
// audit summary / details count that other tooling reads.
test('search_group_memory nudges a broader search only when keywords filtered everything out', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.record(f.chatId, '2026-11-11', [
      { summary: 'Natu and tcdw had lunch together', firstMessageId: 5001n, lastMessageId: 5040n },
    ]);
    const invocationId = seedInvocation(f.store, f.conversationId);
    const search = toolNamed(
      createGroupMemoryReadTools({ store: f.store, configStore: f.configStore, context: context(f, invocationId) }),
      'search_group_memory',
    );
    const datePattern = /\d{4}-\d{2}-\d{2}/;

    const dated = await runTool(search, 'call-dated', { date: '2026-11-11', keywords: ['吃', '饭', '麻辣香锅'] });
    expect(dated.details).toEqual({ count: 0 });
    expect(dated.text).toContain('No group memories matched in this Chat.');
    expect(dated.text).toContain('does not mean nothing relevant was recorded');
    expect(dated.text).toContain('earlier conversation are not required');
    expect(dated.text).toContain('consider searching 2026-11-11 alone, without keywords');

    const undated = await runTool(search, 'call-undated', { keywords: ['麻辣香锅'] });
    expect(undated.details).toEqual({ count: 0 });
    expect(undated.text).toContain('does not mean nothing relevant was recorded');
    expect(undated.text).toContain('fewer or broader keywords');
    expect(undated.text).not.toMatch(datePattern);

    const hit = await runTool(search, 'call-hit', { date: '2026-11-11', keywords: ['lunch'] });
    expect(hit.details).toEqual({ count: 1 });
    expect(hit.text).toContain('Natu and tcdw had lunch together');
    expect(hit.text).not.toContain('does not mean nothing relevant');

    const emptyDay = await runTool(search, 'call-empty-day', { date: '2026-11-12' });
    expect(emptyDay).toEqual({ text: 'No group memories matched in this Chat.', details: { count: 0 } });

    const summaries = f.store.orm
      .select({ toolCallId: toolCalls.toolCallId, resultText: toolCalls.resultText, state: toolCalls.state })
      .from(toolCalls)
      .where(eq(toolCalls.invocationId, invocationId))
      .orderBy(asc(toolCalls.id))
      .all();
    expect(summaries).toEqual([
      { toolCallId: 'call-dated', resultText: 'matches=0', state: 'success' },
      { toolCallId: 'call-undated', resultText: 'matches=0', state: 'success' },
      { toolCallId: 'call-hit', resultText: 'matches=1', state: 'success' },
      { toolCallId: 'call-empty-day', resultText: 'matches=0', state: 'success' },
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

test('read_group_messages marks a runtime-written service body in the header', async () => {
  const f = await groupMemoryFixture();
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 5001,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'joined the group',
      kind: 'service',
      senderName: 'Bob',
      senderTelegramId: 21,
    });
    seedMessage(f.store, f, {
      telegramMessageId: 5002,
      date: new Date('2026-10-01T10:01:00.000Z'),
      text: 'joined the group',
      senderName: 'Mallory',
      senderTelegramId: 22,
    });
    const invocationId = seedInvocation(f.store, f.conversationId);
    const tools = createGroupMemoryReadTools({
      store: f.store,
      configStore: f.configStore,
      context: context(f, invocationId),
    });

    const range = await runTool(toolNamed(tools, 'read_group_messages'), 'call-service', {
      first_message_id: 5001,
      last_message_id: 5002,
    });

    expect(range.text).toContain('[5001 service] Bob\n  joined the group');
    expect(range.text).toContain('[5002] Mallory\n  joined the group');
    expect(auditRows(f.store, invocationId)).toEqual([
      { toolCallId: 'call-service', toolName: 'read_group_messages', state: 'success', errorCode: null },
    ]);
  } finally {
    await f.close();
  }
});
