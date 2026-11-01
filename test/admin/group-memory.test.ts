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
  memories.commit(
    chat.chatId,
    '2026-09-10',
    [{ summary: 'Alice discussed the fixture data.', firstMessageId: 900n, lastMessageId: 901n }],
    901n,
  );
  memories.commit(
    chat.chatId,
    '2026-09-11',
    [{ summary: 'A later event.', firstMessageId: 902n, lastMessageId: 902n }],
    902n,
  );

  expect((await f.request('/group-memories')).status).toBe(401);
  const list = await f.call('/group-memories?chat=123456789&day=2026-09-10');
  expect(list.status).toBe(200);
  const body = (await list.json()) as {
    items: { summary: string; first_message_id: string; last_message_id: string; chat: { telegram_chat_id: string } }[];
    next_cursor: string | null;
  };
  expect(body.items).toEqual([
    expect.objectContaining({
      summary: 'Alice discussed the fixture data.',
      first_message_id: '900',
      last_message_id: '901',
      chat: expect.objectContaining({ telegram_chat_id: '123456789' }),
    }),
  ]);
  expect(body.next_cursor).toBeNull();

  const search = await f.call('/group-memories?search=later');
  expect(((await search.json()) as { items: { summary: string }[] }).items.map((item) => item.summary)).toEqual([
    'A later event.',
  ]);
  const firstPage = await f.call('/group-memories?limit=1');
  const firstBody = (await firstPage.json()) as { items: unknown[]; next_cursor: string | null };
  expect(firstBody.items).toHaveLength(1);
  expect(firstBody.next_cursor).toBe('2026-09-11:902');
  const secondPage = await f.call(`/group-memories?limit=1&cursor=${firstBody.next_cursor}`);
  expect(((await secondPage.json()) as { items: unknown[] }).items).toHaveLength(1);
  expect((await f.call('/group-memories?cursor=bad')).status).toBe(400);
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
  memories.commit(
    chat.chatId,
    '2026-09-10',
    [{ summary: 'original summary', firstMessageId: 900n, lastMessageId: 900n }],
    900n,
  );
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

test('group memory admin rejects invalid ids and summaries', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 123_456_789n);
  const memories = new GroupMemoryStore(f.store.orm);
  memories.commit(chat.chatId, '2026-09-10', [{ summary: 'only one', firstMessageId: 1n, lastMessageId: 1n }], 1n);
  const id = f.store.orm.select().from(groupMemories).get()?.id;
  if (id === undefined) {
    throw new Error('group memory seed failed');
  }
  const invalid = await f.call(`/group-memories/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'x'.repeat(151) }),
  });
  expect(invalid.status).toBe(400);
  expect((await f.call('/group-memories/not-an-id')).status).toBe(400);
  expect((await f.call('/group-memories/gmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
});
