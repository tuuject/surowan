import { expect, test } from 'vitest';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { groupMemories } from '../../src/store/schema/index.ts';
import { seedMessage } from '../group-memory/fixtures.ts';
import { seedChat } from '../memo/fixtures.ts';
import { fixture } from './chats-fixtures.ts';

test('group memory admin list is authenticated, filterable and paginated', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  seedMessage(f.store, chat, {
    telegramMessageId: 900,
    date: new Date('2026-09-10T08:00:00.000Z'),
    text: 'Alice discussed the fixture data.',
    senderName: 'Alice',
  });
  seedMessage(f.store, chat, {
    telegramMessageId: 901,
    date: new Date('2026-09-10T08:00:05.000Z'),
    text: 'It should be remembered.',
    senderName: 'Alice',
  });
  const memories = new GroupMemoryStore(f.store.orm);
  memories.record(chat.chatId, '2026-09-10', [
    { summary: 'Alice discussed the fixture data.', firstMessageId: 900n, lastMessageId: 901n },
  ]);
  memories.record(chat.chatId, '2026-09-11', [
    { summary: 'A later event.', firstMessageId: 902n, lastMessageId: 902n },
  ]);

  expect((await f.request('/group-memories')).status).toBe(401);
  const list = await f.call('/group-memories?chat=123456789&day=2026-09-10');
  expect(list.status).toBe(200);
  const body = (await list.json()) as {
    items: { summary: string; first_message_id: string; last_message_id: string; chat: { telegram_chat_id: string } }[];
    total: number;
    new_count: number;
  };
  expect(body.items).toEqual([
    expect.objectContaining({
      summary: 'Alice discussed the fixture data.',
      first_message_id: '900',
      last_message_id: '901',
      chat: expect.objectContaining({ telegram_chat_id: '123456789' }),
    }),
  ]);
  expect(body).toMatchObject({ total: 1, new_count: 0 });

  const search = await f.call('/group-memories?search=later');
  expect(((await search.json()) as { items: { summary: string }[] }).items.map((item) => item.summary)).toEqual([
    'A later event.',
  ]);
  const firstPage = await f.call('/group-memories?limit=1');
  const firstBody = (await firstPage.json()) as { items: unknown[]; total: number; as_of: string };
  expect(firstBody.items).toHaveLength(1);
  expect(firstBody.total).toBe(2);
  expect(firstBody.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const secondPage = await f.call(`/group-memories?limit=1&offset=1&as_of=${firstBody.as_of}`);
  expect(((await secondPage.json()) as { items: unknown[] }).items).toHaveLength(1);
  for (const bad of ['as_of=bad', 'as_of=2026-09-11', 'as_of=2026-02-30T00:00:00.000Z', 'offset=-1', 'offset=01']) {
    const response = await f.call(`/group-memories?${bad}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      bad.startsWith('as_of') ? 'invalid_as_of' : 'invalid_offset',
    );
  }
});

test('group memory admin pages one snapshot while sleeping writes an event that sorts in between', async () => {
  const f = await fixture();
  const memories = new GroupMemoryStore(f.store.orm);
  const written = new Date(Date.now() - 60_000);
  // Telegram numbers messages per Chat, so two groups easily share a range start.
  for (const telegramChatId of [111_111_111n, 222_222_222n, 333_333_333n]) {
    const chat = seedChat(f.store, telegramChatId);
    memories.record(
      chat.chatId,
      '2026-09-10',
      [{ summary: `Event in ${telegramChatId}`, firstMessageId: 500n, lastMessageId: 510n }],
      written,
    );
  }
  type Body = { items: { chat: { telegram_chat_id: string } }[]; total: number; as_of: string; new_count: number };
  const first = (await (await f.call('/group-memories?limit=1')).json()) as Body;
  expect(first).toMatchObject({ total: 3, as_of: written.toISOString(), new_count: 0 });
  // An older day's event can be written later; it would sort before the
  // remaining rows of 2026-09-10, so a live listing would repeat one of them.
  const late = seedChat(f.store, 444_444_444n);
  memories.record(
    late.chatId,
    '2026-09-10',
    [{ summary: 'Late event', firstMessageId: 900n, lastMessageId: 901n }],
    new Date(written.getTime() + 1_000),
  );
  const seen = first.items.map((item) => item.chat.telegram_chat_id);
  for (const offset of [1, 2, 3]) {
    const page = (await (await f.call(`/group-memories?limit=1&offset=${offset}&as_of=${first.as_of}`)).json()) as Body;
    expect(page).toMatchObject({ total: 3, as_of: first.as_of, new_count: 1 });
    seen.push(...page.items.map((item) => item.chat.telegram_chat_id));
  }
  expect(seen.toSorted()).toEqual(['111111111', '222222222', '333333333']);
  const fresh = (await (await f.call('/group-memories?limit=1')).json()) as Body;
  expect(fresh.items.map((item) => item.chat.telegram_chat_id)).toEqual(['444444444']);
  expect(fresh).toMatchObject({ total: 4, new_count: 0 });
});

test('group memory admin update and delete change only the summary/row', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  seedMessage(f.store, chat, {
    telegramMessageId: 900,
    date: new Date('2026-09-10T08:00:00.000Z'),
    text: 'source text',
    senderName: 'Alice',
  });
  const memories = new GroupMemoryStore(f.store.orm);
  memories.record(chat.chatId, '2026-09-10', [
    { summary: 'original summary', firstMessageId: 900n, lastMessageId: 900n },
  ]);
  const id = f.store.orm.select().from(groupMemories).get()?.id;
  if (id === undefined) {
    throw new Error('group memory seed failed');
  }

  const source = await f.call(`/group-memories/${id}/messages`);
  expect(source.status).toBe(200);
  const sourceBody = (await source.json()) as {
    count: number;
    first_message_id: string;
    last_message_id: string;
    text: string;
  };
  expect(sourceBody).toMatchObject({
    count: 1,
    first_message_id: '900',
    last_message_id: '900',
  });
  expect(sourceBody.text).toContain('source text');

  const updated = await f.call(`/group-memories/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'edited summary' }),
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ summary: 'edited summary', first_message_id: '900' });

  const blank = await f.call(`/group-memories/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary: '   ' }),
  });
  expect(blank.status).toBe(400);

  const removed = await f.call(`/group-memories/${id}`, { method: 'DELETE' });
  expect(removed.status).toBe(200);
  expect(f.store.orm.select().from(groupMemories).all()).toEqual([]);
  expect((await f.call(`/group-memories/${id}/messages`)).status).toBe(404);
});

test('group memory progress shows each lane with its backlog and the reason of the last failure', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  for (const [id, date] of [
    [900, '2026-09-08T08:00:00.000Z'],
    [901, '2026-09-09T08:00:00.000Z'],
    [902, '2026-09-10T08:00:00.000Z'],
  ] as const) {
    seedMessage(f.store, chat, { telegramMessageId: id, date: new Date(date), text: `message ${id}` });
  }
  const memories = new GroupMemoryStore(f.store.orm);
  memories.activate(chat.chatId, 0n);
  // Message 900 is backlog; the live lane starts after it.
  memories.split(chat.chatId, 900n);
  const claimed = memories.claim(chat.chatId, 'live') ?? '';
  memories.fail(chat.chatId, 'live', claimed, 'group_memory_invalid_output');
  const run = memories.startRun({
    chatId: chat.chatId,
    lane: 'live',
    day: '2026-09-09',
    firstMessageId: 901n,
    throughMessageId: 901n,
    messages: 1,
  });
  memories.finishRun(run, {
    state: 'error',
    throughMessageId: 901n,
    messages: 1,
    events: null,
    modelCalls: 2,
    errorCode: 'group_memory_invalid_output',
    errorDetail: 'The tool model returned invalid JSON',
  });

  expect((await f.request('/group-memories/progress')).status).toBe(401);
  const progress = await f.call('/group-memories/progress');
  expect(progress.status).toBe(200);
  expect(await progress.json()).toEqual({
    items: [
      expect.objectContaining({
        chat: expect.objectContaining({ telegram_chat_id: '123456789' }),
        lanes: [
          expect.objectContaining({
            lane: 'live',
            through_message_id: '900',
            through_at: '2026-09-08T08:00:00.000Z',
            until_message_id: null,
            pending: 2,
            state: 'idle',
            error_code: 'group_memory_invalid_output',
            consecutive_failures: 1,
          }),
          expect.objectContaining({
            lane: 'backfill',
            through_message_id: '0',
            through_at: null,
            until_message_id: '900',
            until_at: '2026-09-08T08:00:00.000Z',
            pending: 1,
            error_code: null,
          }),
        ],
        memories: { count: 0, latest_day: null },
        newest_message_at: '2026-09-10T08:00:00.000Z',
        runs_24h: { success: 0, error: 1, model_calls: 2 },
        last_error: expect.objectContaining({
          code: 'group_memory_invalid_output',
          detail: 'The tool model returned invalid JSON',
          lane: 'live',
          day: '2026-09-09',
        }),
      }),
    ],
  });

  const runs = await f.call('/group-memories/runs?chat=123456789&state=error');
  expect(runs.status).toBe(200);
  expect(await runs.json()).toMatchObject({
    total: 1,
    items: [
      {
        lane: 'live',
        day: '2026-09-09',
        first_message_id: '901',
        through_message_id: '901',
        state: 'error',
        model_calls: 2,
        error_code: 'group_memory_invalid_output',
      },
    ],
  });
  expect((await f.call('/group-memories/runs?state=failed')).status).toBe(400);
  expect((await f.call('/group-memories/runs?chat=987654321')).status).toBe(200);

  // Switching the Chat off drops its lanes, so it leaves the progress list.
  memories.deactivate([chat.chatId]);
  expect(await (await f.call('/group-memories/progress')).json()).toEqual({ items: [] });
});
