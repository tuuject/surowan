import { expect, test } from 'vitest';
import { groupMemoryRuns } from '../../src/store/schema/index.ts';
import { groupMemoryFixture } from './fixtures.ts';

function range(first: number, last = first) {
  return { summary: `event ${first}`, firstMessageId: BigInt(first), lastMessageId: BigInt(last) };
}

test('commit persists events and advances the claimed lane in one step', async () => {
  const f = await groupMemoryFixture();
  try {
    const claimed = f.groupMemory.claim(f.chatId, 'live');
    expect(claimed).toBeDefined();
    expect(
      f.groupMemory.commit(
        f.chatId,
        'live',
        claimed ?? '',
        '2026-10-01',
        [range(4005, 4114), range(4123, 4145)],
        4145n,
      ),
    ).toBe(true);
    const entries = f.groupMemory.list(f.chatId);
    expect(entries.map((entry) => [entry.day, entry.summary, entry.firstMessageId, entry.lastMessageId])).toEqual([
      ['2026-10-01', 'event 4005', 4005n, 4114n],
      ['2026-10-01', 'event 4123', 4123n, 4145n],
    ]);
    expect(f.groupMemory.lane(f.chatId, 'live')).toMatchObject({
      throughMessageId: 4145n,
      state: 'idle',
      claimedAt: null,
      consecutiveFailures: 0n,
    });
  } finally {
    await f.close();
  }
});

test('a commit whose claim is gone writes nothing', async () => {
  const f = await groupMemoryFixture();
  try {
    const start = new Date('2026-10-01T00:00:00.000Z');
    const claimed = f.groupMemory.claim(f.chatId, 'live', start) ?? '';
    // The switch went off and on while the model ran: the lane was re-created.
    f.groupMemory.deactivate([f.chatId]);
    f.groupMemory.activate(f.chatId, 9_000n, start);
    expect(f.groupMemory.commit(f.chatId, 'live', claimed, '2026-10-01', [range(10, 20)], 20n, start)).toBe(false);
    expect(f.groupMemory.list(f.chatId)).toEqual([]);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(9_000n);
  } finally {
    await f.close();
  }
});

test('list filters by day and keyword threshold, newest day first', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.record(f.chatId, '2026-10-01', [range(10, 20)]);
    f.groupMemory.record(f.chatId, '2026-10-02', [
      { summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 30n, lastMessageId: 40n },
      { summary: 'Spring Festival plans', firstMessageId: 41n, lastMessageId: 42n },
    ]);
    expect(f.groupMemory.list(f.chatId, { day: '2026-10-01' }).map((entry) => entry.summary)).toEqual(['event 10']);
    expect(f.groupMemory.list(f.chatId, { keywords: ['esim'] }).map((entry) => entry.summary)).toEqual([
      'Natu and tcdw discussed eSIM prices',
    ]);
    expect(f.groupMemory.list(f.chatId, { keywords: ['esim', 'prices'] })).toHaveLength(1);
    expect(f.groupMemory.list(f.chatId, { keywords: ['esim', 'natu', 'spring', 'missing'] })).toHaveLength(1);
    expect(f.groupMemory.list(f.chatId).map((entry) => entry.day)).toEqual(['2026-10-02', '2026-10-02', '2026-10-01']);
  } finally {
    await f.close();
  }
});

test('entries and lanes are Chat-scoped', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.record(f.chatId, '2026-10-01', [range(1, 2)]);
    expect(f.groupMemory.list(999n)).toEqual([]);
    expect(f.groupMemory.lanes(999n)).toEqual([]);
    expect(f.groupMemory.claim(999n, 'live')).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('claim refuses a live claim and a pending backoff, then recovers a stale claim', async () => {
  const f = await groupMemoryFixture();
  try {
    const start = new Date('2026-10-01T00:00:00.000Z');
    const claimed = f.groupMemory.claim(f.chatId, 'live', start);
    expect(claimed).toBeDefined();
    expect(f.groupMemory.claim(f.chatId, 'live', new Date(start.getTime() + 60_000))).toBeUndefined();
    f.groupMemory.fail(f.chatId, 'live', claimed ?? '', 'group_memory_invalid_output', start);
    expect(f.groupMemory.lane(f.chatId, 'live')).toMatchObject({
      state: 'idle',
      errorCode: 'group_memory_invalid_output',
      consecutiveFailures: 1n,
    });
    expect(f.groupMemory.lane(f.chatId, 'live')?.nextAttemptAt).not.toBeNull();
    expect(f.groupMemory.claim(f.chatId, 'live', new Date(start.getTime() + 60_000))).toBeUndefined();
    expect(f.groupMemory.claim(f.chatId, 'live', new Date(start.getTime() + 31 * 60_000))).toBeDefined();

    // A crash leaves `running`; the next start recovers it after the stale window.
    const beforeCrash = new Date(start.getTime() + 31 * 60_000);
    expect(f.groupMemory.recoverStale(new Date(beforeCrash.getTime() + 60_000))).toBe(0);
    expect(f.groupMemory.recoverStale(new Date(beforeCrash.getTime() + 31 * 60_000))).toBe(1);
    expect(f.groupMemory.lane(f.chatId, 'live')?.errorCode).toBe('stale_claim');
    expect(f.groupMemory.claim(f.chatId, 'live', new Date(beforeCrash.getTime() + 32 * 60_000))).toBeDefined();
  } finally {
    await f.close();
  }
});

test('a split hands the backlog to a backfill lane that ends where the live lane starts', async () => {
  const f = await groupMemoryFixture();
  try {
    const at = new Date('2026-10-05T00:00:00.000Z');
    f.groupMemory.deactivate([f.chatId]);
    f.groupMemory.activate(f.chatId, 100n, at);
    expect(f.groupMemory.split(f.chatId, 100n, at)).toBe(false);
    expect(f.groupMemory.split(f.chatId, 500n, at)).toBe(true);
    expect(f.groupMemory.split(f.chatId, 900n, at)).toBe(false);
    expect(
      f.groupMemory.lanes(f.chatId).map((lane) => [lane.lane, lane.throughMessageId, lane.untilMessageId]),
    ).toEqual([
      ['live', 500n, null],
      ['backfill', 100n, 500n],
    ]);
    // Each lane has its own claim and backoff: a failing backfill leaves live free.
    const backfill = f.groupMemory.claim(f.chatId, 'backfill', at) ?? '';
    f.groupMemory.fail(f.chatId, 'backfill', backfill, 'group_memory_error', at);
    expect(f.groupMemory.claim(f.chatId, 'live', at)).toBeDefined();

    // The backfill lane disappears with the commit that reaches its end.
    const later = new Date(at.getTime() + 31 * 60_000);
    const claimed = f.groupMemory.claim(f.chatId, 'backfill', later) ?? '';
    expect(f.groupMemory.commit(f.chatId, 'backfill', claimed, '2026-10-01', [range(200, 300)], 500n, later)).toBe(
      true,
    );
    expect(f.groupMemory.lanes(f.chatId).map((lane) => lane.lane)).toEqual(['live']);
  } finally {
    await f.close();
  }
});

test('activation keeps an existing lane and deactivation drops every lane', async () => {
  const f = await groupMemoryFixture({ extraChatIds: [-1001] });
  try {
    const other = f.extraChats[0]?.chatId ?? 0n;
    expect(f.groupMemory.activate(f.chatId, 50n)).toBe(false);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(0n);
    expect(f.groupMemory.split(f.chatId, 10n)).toBe(true);
    expect(f.groupMemory.deactivateAllExcept([other])).toBe(2);
    expect(f.groupMemory.lanes(f.chatId)).toEqual([]);
    expect(f.groupMemory.lanes(other)).toHaveLength(1);
    expect(f.groupMemory.activate(f.chatId, 50n)).toBe(true);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(50n);
  } finally {
    await f.close();
  }
});

test('runs record each batch and a restart closes the ones left open', async () => {
  const f = await groupMemoryFixture();
  try {
    const at = new Date('2026-10-02T00:00:00.000Z');
    const run = { chatId: f.chatId, lane: 'live' as const, day: '2026-10-01', firstMessageId: 10n, messages: 3 };
    const done = f.groupMemory.startRun({ ...run, throughMessageId: 30n }, at);
    f.groupMemory.finishRun(
      done,
      {
        state: 'error',
        throughMessageId: 20n,
        messages: 2,
        events: null,
        modelCalls: 2,
        errorCode: 'group_memory_invalid_output',
        errorDetail: 'The tool model returned invalid JSON',
      },
      at,
    );
    f.groupMemory.startRun({ ...run, throughMessageId: 30n }, at);
    expect(f.groupMemory.interruptRuns(at)).toBe(1);
    const rows = f.store.orm.select().from(groupMemoryRuns).all();
    expect(rows.map((row) => [row.state, row.throughMessageId, row.modelCalls, row.errorCode])).toEqual([
      ['error', 20n, 2n, 'group_memory_invalid_output'],
      ['error', 30n, 0n, 'interrupted'],
    ]);
  } finally {
    await f.close();
  }
});

test('a keyword search reaches an entry older than thousands of non-matching ones', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.record(f.chatId, '2025-01-01', [{ ...range(1), summary: 'The Ärger about the needle' }]);
    // 6,000 newer entries: well past one scan page, so the needle sits beyond it.
    for (let day = 0; day < 6; day += 1) {
      const date = `2026-0${day + 1}-01`;
      const events = Array.from({ length: 1_000 }, (_, index) => range(10_000 * (day + 1) + index));
      f.groupMemory.record(f.chatId, date, events);
    }
    expect(f.groupMemory.list(f.chatId, { keywords: ['ärger'] }).map((entry) => entry.summary)).toEqual([
      'The Ärger about the needle',
    ]);
    // Without keywords the newest page is returned directly.
    expect(f.groupMemory.list(f.chatId, { limit: 2 }).map((entry) => entry.firstMessageId)).toEqual([60_000n, 60_001n]);
  } finally {
    await f.close();
  }
});
