import { afterEach, expect, test, vi } from 'vitest';
import {
  AddMemoInputSchema,
  ReadMemoryInputSchema,
  MEMO_DETAIL_MAX_LENGTH,
  SearchMemoryInputSchema,
  UpdateMemoInputSchema,
} from '../../src/context/memo-pad/index.ts';
import { createReplayTools } from '../../src/orchestration/replay/tools.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { callCapability, definition, envelopeOf, replayInput, textOf, toolOf } from './tools-fixtures.ts';

afterEach(() => vi.useRealTimers());

function memoryReplay() {
  return createReplayTools(
    replayInput({
      tools: [
        definition('execute'),
        definition('search_memory', SearchMemoryInputSchema),
        definition('read_memory', ReadMemoryInputSchema),
      ],
      capabilities: [definition('add_memo', AddMemoInputSchema), definition('update_memo', UpdateMemoInputSchema)],
    }),
    emptySystemResources(),
  );
}

function savedId(text: string): string {
  const id = text.match(/mem_[a-f0-9]{32}/)?.[0];
  if (id === undefined) {
    throw new Error('Missing saved memory id');
  }
  return id;
}

test('replay memory expiry excludes searches and denies reads and revival at the exact boundary', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date('2026-10-30T12:00:00.000Z');
  vi.setSystemTime(now);
  const replay = memoryReplay();
  const added = envelopeOf(
    await callCapability(replay, 'add', 'add_memo', {
      summary: 'temporary note',
      detail: 'private detail',
      ttl_seconds: 60,
    }),
  );
  const id = savedId(added.text);
  const search = toolOf(replay.tools, 'search_memory');
  const read = toolOf(replay.tools, 'read_memory');
  vi.setSystemTime(now.getTime() + 59_999);
  expect((await search.execute('before-search', {})).details).toEqual({ count: 1 });
  expect(textOf(await read.execute('before-read', { id }))).toContain('private detail');
  vi.setSystemTime(now.getTime() + 60_000);
  expect((await search.execute('expired-search', {})).details).toEqual({ count: 0 });
  await expect(read.execute('expired-read', { id })).rejects.toThrow('Memory not found');
  await expect(callCapability(replay, 'revive', 'update_memo', { id, ttl_seconds: null })).rejects.toThrow(
    'Memory not found',
  );
  expect((await search.execute('after-revive', {})).details).toEqual({ count: 0 });
  expect(replay.dispatches).toEqual(
    expect.arrayContaining([
      { tool_call_id: 'before-search', tool_name: 'search_memory', mode: 'synthetic' },
      { tool_call_id: 'before-read', tool_name: 'read_memory', mode: 'synthetic' },
      { tool_call_id: 'expired-search', tool_name: 'search_memory', mode: 'synthetic' },
      { tool_call_id: 'expired-read', tool_name: 'read_memory', mode: 'synthetic' },
    ]),
  );
});

test('replay search shares full-day bounds, unique keywords and invalid-range errors with live memory', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const replay = memoryReplay();
  vi.setSystemTime(new Date('2026-10-30T23:59:59.999Z'));
  const today = savedId(
    envelopeOf(
      await callCapability(replay, 'today', 'add_memo', {
        summary: 'cats',
        detail: 'today detail',
      }),
    ).text,
  );
  vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
  const tomorrow = savedId(
    envelopeOf(
      await callCapability(replay, 'tomorrow', 'add_memo', {
        summary: 'cats',
        detail: 'tomorrow detail',
      }),
    ).text,
  );
  const search = toolOf(replay.tools, 'search_memory');
  const result = await search.execute('day', { from: '2026-10-30', to: '2026-10-30' });
  expect(result.details).toEqual({ count: 1 });
  expect(textOf(result)).toContain(today);
  expect(textOf(result)).not.toContain(tomorrow);
  expect((await search.execute('timestamp', { to: '2026-10-30T00:00:00Z' })).details).toEqual({ count: 0 });
  expect((await search.execute('keywords', { keywords: ['cats', 'absent', ' ABSENT '] })).details).toEqual({
    count: 2,
  });
  await expect(search.execute('invalid', { from: '2026-10-31', to: '2026-10-30' })).rejects.toThrow(
    'from must not be later than to',
  );
});

test.each(['x', '猫', '\u0000'])('replay accepts full memo detail for %j through execute', async (character) => {
  const replay = memoryReplay();
  const detail = character.repeat(MEMO_DETAIL_MAX_LENGTH);
  const added = envelopeOf(await callCapability(replay, 'add-large', 'add_memo', { summary: 'maximum', detail }));
  const id = savedId(added.text);
  const read = toolOf(replay.tools, 'read_memory');
  expect(textOf(await read.execute('read-large', { id }))).toContain(detail);
  await callCapability(replay, 'update-large', 'update_memo', { id, detail });
  expect(textOf(await read.execute('read-updated', { id }))).toContain(detail);
  await expect(
    callCapability(replay, 'oversize', 'update_memo', { id, detail: `${detail}${character}` }),
  ).rejects.toThrow('input does not match the schema');
});
