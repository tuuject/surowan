import { expect, test } from 'vitest';
import { groupMemoryFixture } from './fixtures.ts';

function range(first: number, last = first) {
  return { summary: `event ${first}`, firstMessageId: BigInt(first), lastMessageId: BigInt(last) };
}

test('commit persists events and advances the watermark in one step', async () => {
  const f = await groupMemoryFixture();
  try {
    expect(f.groupMemory.claim(f.chatId)).toBe(true);
    f.groupMemory.commit(f.chatId, '2026-10-01', [range(4005, 4114), range(4123, 4145)], 4145n);
    const entries = f.groupMemory.list(f.chatId);
    expect(entries.map((entry) => [entry.day, entry.summary, entry.firstMessageId, entry.lastMessageId])).toEqual([
      ['2026-10-01', 'event 4005', 4005n, 4114n],
      ['2026-10-01', 'event 4123', 4123n, 4145n],
    ]);
    expect(f.groupMemory.state(f.chatId)?.consolidatedThroughMessageId).toBe(4145n);
    expect(f.groupMemory.state(f.chatId)?.state).toBe('idle');
  } finally {
    await f.close();
  }
});

test('list filters by day and keyword threshold, newest day first', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.commit(f.chatId, '2026-10-01', [range(10, 20)], 20n);
    f.groupMemory.commit(
      f.chatId,
      '2026-10-02',
      [
        { summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 30n, lastMessageId: 40n },
        { summary: 'Spring Festival plans', firstMessageId: 41n, lastMessageId: 42n },
      ],
      42n,
    );
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

test('entries and state are Chat-scoped', async () => {
  const f = await groupMemoryFixture();
  try {
    f.groupMemory.commit(f.chatId, '2026-10-01', [range(1, 2)], 2n);
    expect(f.groupMemory.list(999n)).toEqual([]);
    expect(f.groupMemory.state(999n)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('claim refuses a live claim and a pending backoff, then recovers a stale claim', async () => {
  const f = await groupMemoryFixture();
  try {
    const start = new Date('2026-10-01T00:00:00.000Z');
    expect(f.groupMemory.claim(f.chatId, start)).toBe(true);
    expect(f.groupMemory.claim(f.chatId, new Date(start.getTime() + 60_000))).toBe(false);
    f.groupMemory.fail(f.chatId, 'group_memory_error', start);
    expect(f.groupMemory.state(f.chatId)?.state).toBe('idle');
    expect(f.groupMemory.state(f.chatId)?.nextAttemptAt).not.toBeNull();
    expect(f.groupMemory.claim(f.chatId, new Date(start.getTime() + 60_000))).toBe(false);
    expect(f.groupMemory.claim(f.chatId, new Date(start.getTime() + 31 * 60_000))).toBe(true);

    // A crash leaves `running`; the next start recovers it after the stale window.
    const beforeCrash = new Date(start.getTime() + 31 * 60_000);
    expect(f.groupMemory.recoverStale(new Date(beforeCrash.getTime() + 60_000))).toBe(0);
    expect(f.groupMemory.recoverStale(new Date(beforeCrash.getTime() + 31 * 60_000))).toBe(1);
    expect(f.groupMemory.state(f.chatId)?.errorCode).toBe('stale_claim');
    expect(f.groupMemory.claim(f.chatId, new Date(beforeCrash.getTime() + 32 * 60_000))).toBe(true);
  } finally {
    await f.close();
  }
});
