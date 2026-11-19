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
    hostChatId: f.telegramChatId,
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
      sql`INSERT INTO chats (id, host_kind, host_chat_id, canonical_chat_id, type, updated_at)
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

type ThirtyHourClockSetting = 'off' | 'non_overlapping' | 'overlapping' | undefined;

function publishThirtyHourClock(f: Awaited<ReturnType<typeof groupMemoryFixture>>, clock: ThirtyHourClockSetting) {
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: {
      ...current.config,
      telegram: {
        ...current.config.telegram,
        chats: current.config.telegram.chats.map((chat) =>
          BigInt(chat.id) === f.telegramChatId
            ? {
                ...chat,
                timezone: 'Asia/Tokyo',
                group_memory: {
                  enabled: true,
                  idle_minutes: 30,
                  ...(clock === undefined ? {} : { thirty_hour_clock: clock }),
                },
              }
            : chat,
        ),
      },
    },
  });
}

function listedSummaries(text: string): string[] {
  return [...text.matchAll(/^- gmem_[a-f0-9]{32} \[[^\]]+\]: (.+)$/gm)].map((match) => match[1] ?? '');
}

// Ways the 30-hour day can fail: changing calendar searches while it is off;
// keeping the date's own small hours, or dropping the next date's, in the
// non-overlapping mode; an off-by-one at either 06:00 boundary; resolving 06:00
// in UTC instead of the Chat timezone; losing an event whose first message is
// no longer stored, or listing it under two dates; letting another Chat's
// message with the same Telegram id decide an event's hour; listing the next
// date's small hours before the date's daytime; reading the mode only when the
// tool was built, so a hot-applied change waits for a rebuild; touching an
// undated search; and leaving the model to guess which hours a date covered.
test('search_group_memory widens a dated search to a 30-hour day when the Chat opts in', async () => {
  const f = await groupMemoryFixture();
  try {
    // Asia/Tokyo is UTC+9 all year: 2026-11-18 06:00 local is 2026-11-17T21:00Z.
    const seed = (telegramMessageId: number, iso: string) =>
      seedMessage(f.store, f, { telegramMessageId, date: new Date(iso), text: `message ${telegramMessageId}` });
    seed(100, '2026-11-17T18:00:00.000Z'); // 11-18 03:00
    seed(200, '2026-11-17T21:00:00.000Z'); // 11-18 06:00
    seed(300, '2026-11-18T12:00:00.000Z'); // 11-18 21:00
    seed(400, '2026-11-18T20:59:00.000Z'); // 11-19 05:59
    seed(500, '2026-11-18T21:00:00.000Z'); // 11-19 06:00
    f.store.orm.run(
      sql`INSERT INTO chats (id, host_kind, host_chat_id, canonical_chat_id, type, updated_at)
          VALUES (2, 'telegram', 987654321, 987654321, 'supergroup', '2026-01-01T00:00:00.000Z')`,
    );
    // Another Chat's message 100 was sent at 11-18 10:00; it must not make the
    // small-hours event look like daytime.
    seedMessage(
      f.store,
      { chatId: 2n, conversationId: 0n },
      { telegramMessageId: 100, date: new Date('2026-11-18T01:00:00.000Z'), text: 'other chat' },
    );
    f.groupMemory.record(f.chatId, '2026-11-18', [
      { summary: 'Small-hours chat before dawn', firstMessageId: 100n, lastMessageId: 150n },
      { summary: 'Breakfast plans at six', firstMessageId: 200n, lastMessageId: 250n },
      { summary: 'Evening game night', firstMessageId: 300n, lastMessageId: 350n },
      // Its raw messages are gone, so only the calendar date it was filed under is known.
      { summary: 'Orphaned afternoon summary', firstMessageId: 600n, lastMessageId: 610n },
    ]);
    f.groupMemory.record(f.chatId, '2026-11-19', [
      { summary: 'Late-night ramen run', firstMessageId: 400n, lastMessageId: 450n },
      { summary: 'Next morning commute', firstMessageId: 500n, lastMessageId: 550n },
      { summary: 'Orphaned next-day summary', firstMessageId: 700n, lastMessageId: 710n },
    ]);
    publishThirtyHourClock(f, undefined);
    const invocationId = seedInvocation(f.store, f.conversationId);
    const search = toolNamed(
      createGroupMemoryReadTools({ store: f.store, configStore: f.configStore, context: context(f, invocationId) }),
      'search_group_memory',
    );
    const calendar = [
      'Small-hours chat before dawn',
      'Breakfast plans at six',
      'Evening game night',
      'Orphaned afternoon summary',
    ];

    const off = await runTool(search, 'call-off', { date: '2026-11-18' });
    expect(listedSummaries(off.text)).toEqual(calendar);
    expect(off.text).not.toContain('30-hour');
    publishThirtyHourClock(f, 'off');
    const explicitOff = await runTool(search, 'call-explicit-off', { date: '2026-11-18' });
    expect(explicitOff.text).toBe(off.text);

    publishThirtyHourClock(f, 'non_overlapping');
    const exclusive = await runTool(search, 'call-exclusive', { date: '2026-11-18' });
    expect(listedSummaries(exclusive.text)).toEqual([
      'Breakfast plans at six',
      'Evening game night',
      'Orphaned afternoon summary',
      'Late-night ramen run',
    ]);
    expect(exclusive.details).toEqual({ count: 4 });
    expect(exclusive.text).toContain('30-hour day');
    expect(exclusive.text).toContain('from 2026-11-18 06:00 to 2026-11-19 06:00');
    // Consecutive non-overlapping dates partition the events: each appears once.
    const before = await runTool(search, 'call-exclusive-before', { date: '2026-11-17' });
    expect(listedSummaries(before.text)).toEqual(['Small-hours chat before dawn']);
    const after = await runTool(search, 'call-exclusive-after', { date: '2026-11-19' });
    expect(listedSummaries(after.text)).toEqual(['Next morning commute', 'Orphaned next-day summary']);

    const ramen = await runTool(search, 'call-exclusive-keyword', { date: '2026-11-18', keywords: ['ramen'] });
    expect(listedSummaries(ramen.text)).toEqual(['Late-night ramen run']);
    const dawn = await runTool(search, 'call-exclusive-miss', { date: '2026-11-18', keywords: ['dawn'] });
    expect(dawn.details).toEqual({ count: 0 });
    expect(dawn.text).toContain('from 2026-11-18 06:00 to 2026-11-19 06:00');
    expect(dawn.text).toContain('consider searching 2026-11-18 alone, without keywords');

    const undated = await runTool(search, 'call-undated', {});
    expect(undated.details).toEqual({ count: 7 });
    expect(undated.text).not.toContain('30-hour');

    publishThirtyHourClock(f, 'overlapping');
    const overlapping = await runTool(search, 'call-overlapping', { date: '2026-11-18' });
    expect(listedSummaries(overlapping.text)).toEqual([...calendar, 'Late-night ramen run']);
    expect(overlapping.text).toContain('30-hour day');
    expect(overlapping.text).toContain('from 2026-11-18 00:00 to 2026-11-19 06:00');

    const audited = f.store.orm
      .select({ toolCallId: toolCalls.toolCallId, resultText: toolCalls.resultText, state: toolCalls.state })
      .from(toolCalls)
      .where(eq(toolCalls.invocationId, invocationId))
      .orderBy(asc(toolCalls.id))
      .all();
    expect(audited).toEqual([
      { toolCallId: 'call-off', resultText: 'matches=4', state: 'success' },
      { toolCallId: 'call-explicit-off', resultText: 'matches=4', state: 'success' },
      { toolCallId: 'call-exclusive', resultText: 'matches=4', state: 'success' },
      { toolCallId: 'call-exclusive-before', resultText: 'matches=1', state: 'success' },
      { toolCallId: 'call-exclusive-after', resultText: 'matches=2', state: 'success' },
      { toolCallId: 'call-exclusive-keyword', resultText: 'matches=1', state: 'success' },
      { toolCallId: 'call-exclusive-miss', resultText: 'matches=0', state: 'success' },
      { toolCallId: 'call-undated', resultText: 'matches=7', state: 'success' },
      { toolCallId: 'call-overlapping', resultText: 'matches=5', state: 'success' },
    ]);
  } finally {
    await f.close();
  }
});

// Ways a 30-hour search can fail once the Chat's timezone changed after its
// events were filed: trusting the filed date over the first message's time, so
// an event filed under the old zone's date is listed under the wrong date;
// looking only at the date and the next one, so an event the new zone moves
// onto an earlier filed date is never found; listing an event under two
// non-overlapping dates; and losing an event whose first message is gone.
test('search_group_memory places events by their first message after the Chat timezone changed', async () => {
  const f = await groupMemoryFixture();
  try {
    // Filed while the Chat ran on UTC; the search now runs on Asia/Tokyo (UTC+9),
    // where the 2026-11-18 30-hour day is 2026-11-17T21:00Z to 2026-11-18T21:00Z.
    const seed = (telegramMessageId: number, iso: string) =>
      seedMessage(f.store, f, { telegramMessageId, date: new Date(iso), text: `message ${telegramMessageId}` });
    seed(100, '2026-11-17T22:00:00.000Z'); // UTC 11-17, Tokyo 11-18 07:00
    seed(200, '2026-11-18T12:00:00.000Z'); // UTC 11-18, Tokyo 11-18 21:00
    seed(300, '2026-11-18T23:00:00.000Z'); // UTC 11-18, Tokyo 11-19 08:00
    f.groupMemory.record(f.chatId, '2026-11-17', [
      { summary: 'Tokyo morning filed under the UTC date', firstMessageId: 100n, lastMessageId: 150n },
    ]);
    f.groupMemory.record(f.chatId, '2026-11-18', [
      { summary: 'Tokyo evening', firstMessageId: 200n, lastMessageId: 250n },
      { summary: 'Next Tokyo morning filed under the UTC date', firstMessageId: 300n, lastMessageId: 350n },
      { summary: 'Orphaned summary', firstMessageId: 600n, lastMessageId: 610n },
    ]);
    publishThirtyHourClock(f, 'non_overlapping');
    const search = toolNamed(
      createGroupMemoryReadTools({
        store: f.store,
        configStore: f.configStore,
        context: context(f, seedInvocation(f.store, f.conversationId)),
      }),
      'search_group_memory',
    );

    const day = await runTool(search, 'call-day', { date: '2026-11-18' });
    expect(listedSummaries(day.text)).toEqual([
      'Tokyo morning filed under the UTC date',
      'Tokyo evening',
      'Orphaned summary',
    ]);
    const before = await runTool(search, 'call-before', { date: '2026-11-17' });
    expect(listedSummaries(before.text)).toEqual([]);
    const after = await runTool(search, 'call-after', { date: '2026-11-19' });
    expect(listedSummaries(after.text)).toEqual(['Next Tokyo morning filed under the UTC date']);
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
