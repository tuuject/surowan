import { afterEach, expect, test } from 'vitest';
import type { MemoFixture } from './fixtures.ts';
import { memoFixture, seedChat } from './fixtures.ts';

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

test('a record id from another Chat reads as missing for get, update and remove', async () => {
  const f = await fixture();
  const first = seedChat(f.store, 111n);
  const second = seedChat(f.store, 222n);
  const entry = f.memoPad.create(first.chatId, { summary: 'cats', detail: 'the owner has two cats' });

  expect(f.memoPad.get(entry.id, first.chatId)?.summary).toBe('cats');
  expect(f.memoPad.get(entry.id, second.chatId)).toBeUndefined();
  expect(f.memoPad.update(entry.id, second.chatId, { summary: 'stolen' })).toBeUndefined();
  expect(f.memoPad.remove(entry.id, second.chatId)).toBe(false);
  expect(f.memoPad.get(entry.id, first.chatId)?.summary).toBe('cats');
});

test('ttl entries expire while permanent entries stay, and only short-term entries are injected', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-03-01T10:00:00.000Z');
  const permanent = f.memoPad.create(chat.chatId, { summary: 'permanent', detail: 'stays' }, now);
  const short = f.memoPad.create(
    chat.chatId,
    { summary: 'short', detail: 'goes', ttlSeconds: 3_600 },
    new Date('2026-03-01T10:00:01.000Z'),
  );

  expect(permanent.expiresAt).toBeNull();
  expect(short.expiresAt).toBe('2026-03-01T11:00:01.000Z');
  expect(f.memoPad.listActive(chat.chatId, now).map((entry) => entry.id)).toEqual([permanent.id, short.id]);
  expect(f.memoPad.shortTerm(chat.chatId, now).map((entry) => entry.id)).toEqual([short.id]);

  const later = new Date('2026-03-01T12:00:00.000Z');
  expect(f.memoPad.listActive(chat.chatId, later).map((entry) => entry.id)).toEqual([permanent.id]);
  expect(f.memoPad.shortTerm(chat.chatId, later)).toEqual([]);
});

test('search requires one keyword, half of several keywords and matches case-insensitively in summary and detail', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const alpha = f.memoPad.create(
    chat.chatId,
    {
      summary: 'Alpha project notes',
      detail: 'the server runs on port 8080',
    },
    new Date('2026-03-02T00:00:00.000Z'),
  );
  const bravo = f.memoPad.create(
    chat.chatId,
    {
      summary: 'unrelated title',
      detail: 'Bravo is the studio name',
    },
    new Date('2026-03-02T00:00:01.000Z'),
  );
  const charlie = f.memoPad.create(
    chat.chatId,
    {
      summary: 'charlie alpha',
      detail: 'nothing else',
    },
    new Date('2026-03-02T00:00:02.000Z'),
  );
  const delta = f.memoPad.create(
    chat.chatId,
    {
      summary: 'bravo project',
      detail: 'nothing else',
    },
    new Date('2026-03-02T00:00:03.000Z'),
  );
  const echo = f.memoPad.create(
    chat.chatId,
    {
      summary: 'alpha bravo',
      detail: 'nothing else',
    },
    new Date('2026-03-02T00:00:04.000Z'),
  );

  expect(f.memoPad.search(chat.chatId, { keywords: ['ALPHA'] }).map((entry) => entry.id)).toEqual([
    echo.id,
    charlie.id,
    alpha.id,
  ]);
  expect(f.memoPad.search(chat.chatId, { keywords: ['BRAVO'] }).map((entry) => entry.id)).toEqual([
    echo.id,
    delta.id,
    bravo.id,
  ]);
  // ceil(3 / 2) = 2 hits are required, so the one-hit entries are excluded.
  expect(f.memoPad.search(chat.chatId, { keywords: ['alpha', 'bravo', 'charlie'] }).map((entry) => entry.id)).toEqual([
    echo.id,
    charlie.id,
  ]);
  expect(f.memoPad.search(chat.chatId, { keywords: ['project', 'notes', 'bravo'] }).map((entry) => entry.id)).toEqual([
    delta.id,
    alpha.id,
  ]);
  expect(f.memoPad.search(chat.chatId, { keywords: ['unknown'] })).toEqual([]);
});

test('search applies inclusive creation-date bounds, newest-first ordering and the limit', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const first = f.memoPad.create(
    chat.chatId,
    { summary: 'first', detail: 'one' },
    new Date('2026-02-01T00:00:00.000Z'),
  );
  const second = f.memoPad.create(
    chat.chatId,
    { summary: 'second', detail: 'two' },
    new Date('2026-02-02T00:00:00.000Z'),
  );
  const third = f.memoPad.create(
    chat.chatId,
    { summary: 'third', detail: 'three' },
    new Date('2026-02-02T23:30:00.000Z'),
  );
  const fourth = f.memoPad.create(
    chat.chatId,
    { summary: 'fourth', detail: 'four' },
    new Date('2026-02-03T00:00:00.000Z'),
  );

  // A date-only `to` covers the whole day, and from/to are inclusive bounds.
  expect(
    f.memoPad
      .search(chat.chatId, { from: '2026-02-02', to: '2026-02-02' }, new Date('2026-02-04T00:00:00.000Z'))
      .map((entry) => entry.id),
  ).toEqual([third.id, second.id]);
  expect(
    f.memoPad
      .search(
        chat.chatId,
        { from: '2026-02-02T00:00:00.000Z', to: '2026-02-02T23:30:00.000Z' },
        new Date('2026-02-04T00:00:00.000Z'),
      )
      .map((entry) => entry.id),
  ).toEqual([third.id, second.id]);
  expect(f.memoPad.search(chat.chatId, {}, new Date('2026-02-04T00:00:00.000Z')).map((entry) => entry.id)).toEqual([
    fourth.id,
    third.id,
    second.id,
    first.id,
  ]);
  expect(
    f.memoPad.search(chat.chatId, { limit: 2 }, new Date('2026-02-04T00:00:00.000Z')).map((entry) => entry.id),
  ).toEqual([fourth.id, third.id]);
  expect(() => f.memoPad.search(chat.chatId, { from: '2026-02-03', to: '2026-02-02' })).toThrow(
    'from must not be later than to',
  );
});

test('update changes summary, detail and ttl and null promotes back to permanent', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-04-01T00:00:00.000Z');
  const entry = f.memoPad.create(chat.chatId, { summary: 'old', detail: 'old detail' }, now);

  const withTtl = f.memoPad.update(
    entry.id,
    chat.chatId,
    { summary: 'new', detail: 'new detail', ttlSeconds: 600 },
    new Date('2026-04-01T01:00:00.000Z'),
  );
  expect(withTtl).toMatchObject({
    summary: 'new',
    detail: 'new detail',
    createdAt: entry.createdAt,
    expiresAt: '2026-04-01T01:10:00.000Z',
    updatedAt: '2026-04-01T01:00:00.000Z',
  });

  // Omitting ttl_seconds keeps the current expiry.
  const keepExpiry = f.memoPad.update(
    entry.id,
    chat.chatId,
    { summary: 'newer' },
    new Date('2026-04-01T02:00:00.000Z'),
  );
  expect(keepExpiry?.expiresAt).toBe('2026-04-01T01:10:00.000Z');
  expect(keepExpiry?.summary).toBe('newer');

  const promoted = f.memoPad.update(entry.id, chat.chatId, { ttlSeconds: null }, new Date('2026-04-01T03:00:00.000Z'));
  expect(promoted?.expiresAt).toBeNull();
  expect(f.memoPad.shortTerm(chat.chatId, new Date('2026-04-01T04:00:00.000Z'))).toEqual([]);
});

test('delete is idempotent and purgeExpired removes only expired rows', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const other = seedChat(f.store, 222n);
  const now = new Date('2026-05-01T00:00:00.000Z');
  const permanent = f.memoPad.create(chat.chatId, { summary: 'keep', detail: 'permanent' }, now);
  const temporary = f.memoPad.create(chat.chatId, { summary: 'gone', detail: 'short', ttlSeconds: 60 }, now);
  const otherChat = f.memoPad.create(other.chatId, { summary: 'other', detail: 'short', ttlSeconds: 60 }, now);

  expect(f.memoPad.remove(temporary.id, chat.chatId, now)).toBe(true);
  expect(f.memoPad.remove(temporary.id, chat.chatId, now)).toBe(false);
  expect(f.memoPad.remove('mem_00000000000000000000000000000000', chat.chatId, now)).toBe(false);

  const kept = f.memoPad.create(
    chat.chatId,
    { summary: 'expired', detail: 'short', ttlSeconds: 60 },
    new Date('2026-05-01T00:00:00.000Z'),
  );
  expect(f.memoPad.purgeExpired(chat.chatId, new Date('2026-05-01T00:01:01.000Z'))).toBe(1);
  expect(f.memoPad.get(kept.id, chat.chatId)).toBeUndefined();
  expect(f.memoPad.get(permanent.id, chat.chatId)).toBeDefined();
  // The other Chat's expired row is outside a chat-scoped purge.
  expect(f.memoPad.get(otherChat.id, other.chatId)).toBeDefined();
  expect(f.memoPad.purgeExpired(null, new Date('2026-05-01T00:01:01.000Z'))).toBe(1);
  expect(f.memoPad.get(otherChat.id, other.chatId)).toBeUndefined();
});
