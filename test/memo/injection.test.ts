import { afterEach, expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { MemoEntry, MemoStateEntry } from '../../src/context/memo-pad/index.ts';
import { renderMemoDelta, renderMemoInjection, renderMemoList } from '../../src/context/memo-pad/injection.ts';
import { MemoPadStore } from '../../src/context/memo-pad/store.ts';
import { type ContextHeader, ConversationContextStore } from '../../src/context/store.ts';
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

function header(overrides: Partial<ContextHeader> = {}): ContextHeader {
  return {
    id: 1n,
    conversationId: 1n,
    headSeq: 1n,
    nextSeq: 2n,
    sendCountTotal: 0n,
    systemPromptHash: 'hash',
    lastGcAt: null,
    memoRefreshSeq: null,
    memoStateJson: null,
    memoRefreshPending: false,
    ...overrides,
  };
}

function stateEntry(id: string, summary: string, updatedAt: string, createdAt = updatedAt): MemoStateEntry {
  return { id, summary, createdAt, updatedAt };
}

function stateJsonOf(entries: readonly MemoEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      summary: entry.summary,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  );
}

test('an empty short-term list renders no block', () => {
  expect(renderMemoList([], 1_000)).toBe('');
});

test('only short-term entries enter the injected list and delta', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-06-01T00:00:00.000Z');
  f.memoPad.create(chat.chatId, { summary: 'permanent fact', detail: 'never injected' }, now);
  const short = f.memoPad.create(
    chat.chatId,
    { summary: 'temporary fact', detail: 'injected', ttlSeconds: 3_600 },
    now,
  );

  const first = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header(),
    seq: 1n,
    contextWindow: 200_000,
    now,
  });
  expect(first.listText).toContain(short.id);
  expect(first.listText).not.toContain('permanent fact');
  expect(first.deltaText).toBe('');
  expect(first.state).toEqual({
    refreshSeq: 1n,
    stateJson: stateJsonOf(f.memoPad.shortTerm(chat.chatId, now)),
    pending: false,
  });

  // The next batch reuses the announced state: no list, no delta, no update.
  const retained = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({
      headSeq: 1n,
      memoRefreshSeq: 1n,
      memoStateJson: first.state?.stateJson ?? null,
    }),
    seq: 2n,
    contextWindow: 200_000,
    now,
  });
  expect(retained.listText).toBe('');
  expect(retained.deltaText).toBe('');
  expect(retained.state).toBeNull();
});

test('the ten-percent budget hides the oldest entries and reports how many are hidden', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const base = new Date('2026-06-01T00:00:00.000Z');
  const entries = [0, 1, 2, 3].map((index) =>
    f.memoPad.create(
      chat.chatId,
      { summary: String(index).repeat(20), detail: 'detail', ttlSeconds: 3_600 },
      new Date(base.getTime() + index * 1_000),
    ),
  );

  const result = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    // 10% of 2000 characters is 200: the wrappers plus two lines fit.
    contextWindow: 2_000,
    header: header(),
    seq: 1n,
    now: new Date(base.getTime() + 10_000),
  });
  expect(result.listText).toContain('[3 earlier short-term memories are not shown');
  expect(result.listText).not.toContain(entries[0]?.id);
  expect(result.listText).not.toContain(entries[1]?.id);
  expect(result.listText).not.toContain(entries[2]?.id);
  expect(result.listText).toContain(entries[3]?.id);
  const next = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    contextWindow: 2_000,
    header: header({ memoRefreshSeq: 1n, memoStateJson: result.state?.stateJson ?? null }),
    seq: 2n,
    now: new Date(base.getTime() + 10_000),
  });
  expect(next.deltaText).toBe('');
  expect(next.state).toBeNull();
});

test('delta reports added, updated and removed entries and is empty when the state matches', () => {
  const previous = [
    stateEntry('mem_a', 'stays', '2026-06-01T00:00:00.000Z'),
    stateEntry('mem_b', 'removed', '2026-06-01T00:00:00.000Z'),
    stateEntry('mem_c', 'old text', '2026-06-01T00:00:00.000Z'),
  ];
  const current = [
    stateEntry('mem_a', 'stays', '2026-06-01T00:00:00.000Z'),
    stateEntry('mem_c', 'new text', '2026-06-01T01:00:00.000Z'),
    stateEntry('mem_d', 'added', '2026-06-01T02:00:00.000Z'),
  ];

  const delta = renderMemoDelta(previous, current, 10_000);
  expect(delta.text).toBe(
    ['<memo_updates>', '~ mem_c: new text', '+ mem_d: added', '- mem_b: removed', '</memo_updates>'].join('\n'),
  );
  expect(delta.omitted).toBe(0);
  expect(renderMemoDelta(previous, previous, 10_000)).toEqual({ text: '', omitted: 0, state: previous });
});

test('the injected delta is a tail note when the list batch is still retained', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-06-01T00:00:00.000Z');
  const first = f.memoPad.create(chat.chatId, { summary: 'first', detail: 'detail', ttlSeconds: 3_600 }, now);
  f.memoPad.create(chat.chatId, { summary: 'second', detail: 'detail', ttlSeconds: 3_600 }, now);
  const announced = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header(),
    seq: 1n,
    contextWindow: 200_000,
    now,
  });
  const stateBefore = announced.state?.stateJson ?? '';
  f.memoPad.update(first.id, chat.chatId, { summary: 'renamed' }, new Date(now.getTime() + 1_000));

  const result = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({
      headSeq: 1n,
      // The list from batch 1 is still inside the retained window.
      memoRefreshSeq: 1n,
      memoStateJson: stateBefore,
    }),
    seq: 2n,
    contextWindow: 200_000,
    now: new Date(now.getTime() + 2_000),
  });
  expect(result.listText).toBe('');
  expect(result.deltaText).toBe(`<memo_updates>\n~ ${first.id}: renamed\n</memo_updates>`);
  expect(result.state).toEqual({
    refreshSeq: 1n,
    stateJson: JSON.stringify(f.memoPad.state(chat.chatId, new Date(now.getTime() + 2_000))),
    pending: false,
  });
});

test('a full refresh renders when the seq is null, behind head_seq or pending', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-06-01T00:00:00.000Z');
  const entry = f.memoPad.create(chat.chatId, { summary: 'visible', detail: 'detail', ttlSeconds: 3_600 }, now);
  const currentJson = JSON.stringify(f.memoPad.state(chat.chatId, now));

  const nullSeq = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({ memoRefreshSeq: null, memoStateJson: currentJson }),
    seq: 4n,
    contextWindow: 200_000,
    now,
  });
  expect(nullSeq.listText).toContain(entry.id);
  expect(nullSeq.deltaText).toBe('');
  expect(nullSeq.state?.refreshSeq).toBe(4n);

  const behind = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({ headSeq: 7n, memoRefreshSeq: 6n, memoStateJson: currentJson }),
    seq: 7n,
    contextWindow: 200_000,
    now,
  });
  expect(behind.listText).toContain(entry.id);
  expect(behind.deltaText).toBe('');

  const pending = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({ headSeq: 7n, memoRefreshSeq: 7n, memoStateJson: currentJson, memoRefreshPending: true }),
    seq: 8n,
    contextWindow: 200_000,
    now,
  });
  expect(pending.listText).toContain(entry.id);
  expect(pending.deltaText).toBe('');
  // A pending refresh marks the newest batch as the list's batch and clears pending.
  expect(pending.state).toEqual({ refreshSeq: 8n, stateJson: currentJson, pending: false });

  const retained = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({ headSeq: 7n, memoRefreshSeq: 7n, memoStateJson: currentJson }),
    seq: 9n,
    contextWindow: 200_000,
    now,
  });
  expect(retained.listText).toBe('');
  expect(retained.deltaText).toBe('');
  expect(retained.state).toBeNull();
});

test('a delta that cannot fit does not mark the dropped changes as announced', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-06-01T00:00:00.000Z');
  f.memoPad.create(chat.chatId, { summary: 'first', detail: 'first', ttlSeconds: 3_600 }, now);
  f.memoPad.create(chat.chatId, { summary: 'second', detail: 'second', ttlSeconds: 3_600 }, now);
  f.memoPad.create(chat.chatId, { summary: 'third', detail: 'third', ttlSeconds: 3_600 }, now);

  const result = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: header({ memoRefreshSeq: 1n, memoStateJson: '[]' }),
    seq: 2n,
    contextWindow: 10,
    now,
  });
  expect(result.state).toBeNull();
  expect(result.deltaText).toBe('');
});

test('a single oversized change remains unannounced without blocking smaller changes', () => {
  const now = '2026-06-01T00:00:00.000Z';
  const small = stateEntry('mem_small', 'fits', now);
  const large = stateEntry('mem_large', 'x'.repeat(300), now);
  const first = renderMemoDelta([], [small, large], 120);
  expect(first.text).toContain('+ mem_small: fits');
  expect(first.text).not.toContain('mem_large');
  expect(first.text.length).toBeLessThanOrEqual(120);
  expect(first.omitted).toBe(1);
  expect(first.state).toEqual([small]);
  const blocked = renderMemoDelta(first.state, [small, large], 120);
  expect(blocked).toEqual({ text: '', omitted: 1, state: [small] });
  const resumed = renderMemoDelta(blocked.state, [small, large], 500);
  expect(resumed.text).toContain('+ mem_large:');
  expect(resumed.text).not.toContain('mem_small');
  expect(resumed.state).toEqual([small, large]);
});

test('bounded deltas drain additions, updates and removals across SQLite restarts without repeats', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, 111n);
  const now = new Date('2026-06-01T00:00:00.000Z');
  const contexts = new ConversationContextStore(f.store);
  const initial = contexts.open(chat.conversationId, 'hash').header;
  const updates: MemoEntry[] = [];
  const removals: MemoEntry[] = [];
  for (let index = 0; index < 8; index += 1) {
    updates.push(
      f.memoPad.create(
        chat.chatId,
        {
          summary: `update ${index} ${'u'.repeat(40)}`,
          detail: 'before',
          ttlSeconds: 3_600,
        },
        now,
      ),
    );
    removals.push(
      f.memoPad.create(
        chat.chatId,
        {
          summary: `remove ${index} ${'r'.repeat(40)}`,
          detail: 'before',
          ttlSeconds: 3_600,
        },
        now,
      ),
    );
  }
  const full = renderMemoInjection(f.memoPad, {
    chatId: chat.chatId,
    header: initial,
    seq: initial.nextSeq,
    contextWindow: 200_000,
    now,
  });
  if (full.state === null) {
    throw new Error('Expected initial memo snapshot');
  }
  contexts.append(initial, {
    invocationId: null,
    isCheckpoint: true,
    estTokens: 1,
    role: 'user',
    json: JSON.stringify({ role: 'user', content: full.listText, timestamp: now.getTime() }),
    memoState: { ...full.state, refresh: true },
  });
  const expected = new Set<string>();
  const later = new Date(now.getTime() + 1_000);
  for (const entry of updates) {
    // Detail-only edits must advance and announce the revision too.
    f.memoPad.update(entry.id, chat.chatId, { detail: 'after' }, later);
    expected.add(`~ ${entry.id}: ${entry.summary}`);
  }
  for (const entry of removals) {
    f.memoPad.remove(entry.id, chat.chatId, later);
    expected.add(`- ${entry.id}: ${entry.summary}`);
  }
  for (let index = 0; index < 8; index += 1) {
    const entry = f.memoPad.create(
      chat.chatId,
      {
        summary: `addition ${index} ${'a'.repeat(40)}`,
        detail: 'new',
        ttlSeconds: 3_600,
      },
      later,
    );
    expected.add(`+ ${entry.id}: ${entry.summary}`);
  }
  const announced = new Set<string>();
  let batches = 0;
  for (; batches <= expected.size; batches += 1) {
    const restartedStore = await SqliteStore.open(f.loaded.config);
    try {
      const restartedContexts = new ConversationContextStore(restartedStore);
      const currentHeader = restartedContexts.open(chat.conversationId, 'hash').header;
      const result = renderMemoInjection(new MemoPadStore(restartedStore.orm), {
        chatId: chat.chatId,
        header: currentHeader,
        seq: currentHeader.nextSeq,
        contextWindow: 2_500,
        now: later,
      });
      expect(result.listText).toBe('');
      expect(result.deltaText.length).toBeLessThanOrEqual(250);
      if (result.state === null) {
        expect(result.deltaText).toBe('');
        break;
      }
      const lines = result.deltaText.split('\n').filter((line) => /^[+~-] /.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(expected.has(line)).toBe(true);
        expect(announced.has(line)).toBe(false);
        announced.add(line);
      }
      const seq = restartedContexts.append(currentHeader, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 1,
        role: 'user',
        json: JSON.stringify({ role: 'user', content: result.deltaText, timestamp: later.getTime() }),
        memoState: { ...result.state, refresh: false },
      });
      expect(currentHeader.memoRefreshSeq).toBe(1n);
      expect(restartedContexts.header(chat.conversationId)).toEqual(currentHeader);
      expect(restartedContexts.retained(currentHeader).at(-1)).toMatchObject({
        seq,
        message: { role: 'user', content: result.deltaText },
      });
    } finally {
      restartedStore.close();
    }
  }
  expect(batches).toBeGreaterThan(1);
  expect(batches).toBeLessThanOrEqual(expected.size);
  expect(announced).toEqual(expected);
  expect(contexts.header(chat.conversationId)?.memoStateJson).toBe(JSON.stringify(f.memoPad.state(chat.chatId, later)));
});
