/**
 * Runtime catch-up: the bounded backlog pass a replaced token or a recovered
 * connection drains before long polling starts.
 *
 * The pass pages through the whole bot-wide stream (Telegram has no per-chat
 * fetch), keeps the newest 100 messages of each chat, and turns them into
 * catch-up buckets while the Scheduler is already running.
 */
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { runRuntimeCatchUp, type RuntimeCatchUpOptions } from '../../src/runtime-catch-up.ts';
import type { StartupCatchUpApi } from '../../src/startup-catch-up.ts';
import { sleep } from '../helpers.ts';
import type { FixtureConfig } from '../helpers.ts';
import {
  FIRST_CHAT_ID,
  SECOND_CHAT_ID,
  cleanupDirectories,
  commandUpdate,
  fakeApi,
  fixedClock,
  setup,
  textUpdate,
} from '../startup/catch-up-fixtures.ts';

afterAll(cleanupDirectories);

const admins = (config: FixtureConfig): void => {
  config.telegram.admins = [42];
};

type Fixture = Awaited<ReturnType<typeof setup>>;

function drain(
  fixture: Pick<Fixture, 'ingestion' | 'scheduler' | 'commands'>,
  api: StartupCatchUpApi,
  options: Partial<RuntimeCatchUpOptions> = {},
): ReturnType<typeof runRuntimeCatchUp> {
  return runRuntimeCatchUp({
    api,
    ingestion: fixture.ingestion,
    commands: fixture.commands,
    scheduler: fixture.scheduler,
    allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
    botUsername: null,
    now: fixedClock(),
    ...options,
  });
}

const count = (fixture: Fixture, table: string): bigint =>
  fixture.store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? -1n;

function captureEvents(): { readonly entries: Record<string, unknown>[]; restore(): void } {
  const entries: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (!line.startsWith('{')) {
      return;
    }
    entries.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { entries, restore: () => spy.mockRestore() };
}

describe('runtime catch-up', () => {
  test('keeps only the newest 100 messages of each chat', async () => {
    const fixture = await setup(true);
    const updates: Update[] = [];
    for (let index = 1; index <= 150; index += 1) {
      updates.push(textUpdate(index, index, 7, FIRST_CHAT_ID));
    }
    for (let index = 1; index <= 5; index += 1) {
      updates.push(textUpdate(1_000 + index, index, 7, SECOND_CHAT_ID));
    }

    const captured = captureEvents();
    let result: Awaited<ReturnType<typeof drain>>;
    try {
      result = await drain(fixture, fakeApi(updates));
    } finally {
      captured.restore();
    }

    expect(result).toMatchObject({ updates: 155, retained: 105, dropped: 50, storedMessages: 105 });
    expect(result.invocationIds).toHaveLength(2);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        event: 'runtime_catch_up_completed',
        updates: 155,
        retained: 105,
        dropped: 50,
        stored_messages: 105,
        invocations: 2,
      }),
    );
    // The dropped 50 updates are never ingested, so they have no audit row.
    expect(
      fixture.store.db
        .prepare<[], { chat_id: bigint; count: bigint; first: bigint; last: bigint }>(
          `SELECT c.telegram_chat_id AS chat_id, COUNT(*) AS count,
                  MIN(m.telegram_message_id) AS first, MAX(m.telegram_message_id) AS last
           FROM messages m JOIN chats c ON c.id = m.chat_id
           GROUP BY c.telegram_chat_id ORDER BY c.telegram_chat_id`,
        )
        .all(),
    ).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), count: 100n, first: 51n, last: 150n },
      { chat_id: BigInt(SECOND_CHAT_ID), count: 5n, first: 1n, last: 5n },
    ]);
    expect(count(fixture, 'telegram_updates')).toBe(105n);
    expect(
      fixture.store.db
        .prepare<[], { kind: string; state: string; count: bigint }>(
          'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state',
        )
        .all(),
    ).toEqual([{ kind: 'startup_catch_up', state: 'queued', count: 2n }]);
    expect(count(fixture, 'invocations')).toBe(2n);
    // The configured history size still bounds what the model sees.
    expect(
      fixture.store.db
        .prepare<[], { chat_id: bigint; count: bigint; first: bigint; last: bigint }>(
          `SELECT c.telegram_chat_id AS chat_id, COUNT(*) AS count,
                  MIN(m.telegram_message_id) AS first, MAX(m.telegram_message_id) AS last
           FROM invocation_messages im
           JOIN invocations i ON i.id = im.invocation_id
           JOIN conversations v ON v.id = i.conversation_id
           JOIN chats c ON c.id = v.chat_id
           JOIN messages m ON m.id = im.message_id
           GROUP BY c.telegram_chat_id ORDER BY c.telegram_chat_id`,
        )
        .all(),
    ).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), count: 10n, first: 141n, last: 150n },
      { chat_id: BigInt(SECOND_CHAT_ID), count: 5n, first: 1n, last: 5n },
    ]);
    expect(fixture.store.db.prepare("SELECT value FROM app_state WHERE key = 'telegram_startup_catch_up'").get()).toBe(
      undefined,
    );
    fixture.store.close();
  });

  test('replays /pause and /resume in update order beyond the message cap', async () => {
    const fixture = await setup(false, admins);
    const updates: Update[] = [commandUpdate(1, 1_000, '/pause')];
    for (let index = 0; index < 105; index += 1) {
      updates.push(textUpdate(2 + index, 10 + index, 7, FIRST_CHAT_ID));
    }
    updates.push(commandUpdate(200, 2_000, '/resume'));

    const order: string[] = [];
    const run = fixture.commands.run.bind(fixture.commands);
    const spy = vi.spyOn(fixture.commands, 'run').mockImplementation(async (command, chatId, sender, now) => {
      order.push(command.name);
      return await run(command, chatId, sender, now);
    });
    try {
      const result = await drain(fixture, fakeApi(updates));
      // 105 ordinary messages keep the newest 100; both commands are kept even
      // though /pause sits before the window.
      expect(result).toMatchObject({ updates: 107, retained: 102, dropped: 5, storedMessages: 100 });
      expect(result.invocationIds).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }

    expect(order).toEqual(['pause', 'resume']);
    expect(count(fixture, 'messages')).toBe(100n);
    expect(
      fixture.store.db
        .prepare<[], { first: bigint; last: bigint }>(
          'SELECT MIN(telegram_message_id) AS first, MAX(telegram_message_id) AS last FROM messages',
        )
        .get(),
    ).toEqual({ first: 15n, last: 114n });
    // The last command wins, exactly as it would live.
    expect(count(fixture, 'chat_pause')).toBe(0n);
    fixture.store.close();
  });

  test('aborting mid-pass stores the confirmed backlog but creates no catch-up work', async () => {
    const fixture = await setup(false);
    const controller = new AbortController();
    const inner = fixture.ingestion;
    let ingested = 0;
    // Abort after the second stored message: the stream is already drained
    // (and confirmed), which is exactly the state a replaced token leaves
    // behind.
    const ingestion = {
      ingestCatchUp: (update: Update, receivedAt: Date) => {
        const result = inner.ingestCatchUp(update, receivedAt);
        ingested += 1;
        if (ingested === 2) {
          controller.abort();
        }
        return result;
      },
    } as unknown as TelegramIngestion;
    const captured = captureEvents();
    try {
      const result = {
        ...fixture,
        ingestion,
      };
      await expect(
        drain(result, fakeApi([textUpdate(1, 10, 7), textUpdate(2, 11, 7), textUpdate(3, 12, 7)]), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      captured.restore();
    }

    // Telegram will not deliver these again, so the cancel must not skip them.
    expect(ingested).toBe(3);
    expect(count(fixture, 'messages')).toBe(3n);
    expect(count(fixture, 'buckets')).toBe(0n);
    expect(count(fixture, 'invocations')).toBe(0n);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({ event: 'runtime_catch_up_aborted', updates: 3, stored_messages: 3 }),
    );
    expect(captured.entries.some((entry) => entry.event === 'runtime_catch_up_completed')).toBe(false);
    fixture.store.close();
  });

  test('a page that fails after earlier pages were confirmed still stores and schedules them', async () => {
    const fixture = await setup(false);
    const updates: Update[] = [];
    for (let index = 1; index <= 120; index += 1) {
      updates.push(textUpdate(index, index, 7, FIRST_CHAT_ID));
    }
    const healthy = fakeApi(updates);
    const failure = new Error('socket hang up');
    const offsets: (number | undefined)[] = [];
    const api: StartupCatchUpApi = {
      getUpdates: async (options) => {
        offsets.push(options.offset);
        // The second request carries `offset`, which confirms the first page.
        if (options.offset !== undefined) {
          throw failure;
        }
        return await healthy.getUpdates(options);
      },
    };
    const captured = captureEvents();
    try {
      await expect(drain(fixture, api)).rejects.toBe(failure);
    } finally {
      captured.restore();
    }

    expect(offsets).toEqual([undefined, 101]);
    expect(count(fixture, 'messages')).toBe(100n);
    expect(
      fixture.store.db
        .prepare<[], { kind: string; state: string; count: bigint }>(
          'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state',
        )
        .all(),
    ).toEqual([{ kind: 'startup_catch_up', state: 'queued', count: 1n }]);
    expect(count(fixture, 'invocations')).toBe(1n);
    expect(captured.entries).toContainEqual(
      expect.objectContaining({
        event: 'runtime_catch_up_interrupted',
        updates: 100,
        retained: 100,
        stored_messages: 100,
        invocations: 1,
      }),
    );
    fixture.store.close();
  });

  test('keeps a retained message edit and drops an edit of a discarded message', async () => {
    const fixture = await setup(false);
    const updates: Update[] = [];
    for (let index = 1; index <= 105; index += 1) {
      updates.push(textUpdate(index, index, 7, FIRST_CHAT_ID));
    }
    const droppedOriginal = textUpdate(106, 1, 7, FIRST_CHAT_ID).message;
    const keptOriginal = textUpdate(107, 105, 7, FIRST_CHAT_ID).message;
    if (droppedOriginal === undefined || keptOriginal === undefined) {
      throw new Error('Invalid fixture');
    }
    updates.push({ update_id: 106, edited_message: { ...droppedOriginal, text: 'edited away', edit_date: 1 } });
    updates.push({ update_id: 107, edited_message: { ...keptOriginal, text: 'edited kept', edit_date: 2 } });

    const result = await drain(fixture, fakeApi(updates));

    // A revision of a message outside the window would create a message that
    // never existed in the retained conversation.
    expect(result).toMatchObject({ updates: 107, retained: 101, dropped: 6 });
    expect(count(fixture, 'messages')).toBe(100n);
    expect(
      fixture.store.db
        .prepare<[], { telegram_message_id: bigint; revisions: bigint }>(
          `SELECT m.telegram_message_id, COUNT(r.id) AS revisions
           FROM messages m JOIN message_revisions r ON r.message_id = m.id
           GROUP BY m.telegram_message_id ORDER BY m.telegram_message_id`,
        )
        .all(),
    ).toEqual(
      Array.from({ length: 100 }, (_, index) => ({
        telegram_message_id: BigInt(index + 6),
        revisions: index + 6 === 105 ? 2n : 1n,
      })),
    );
    expect(count(fixture, 'telegram_updates')).toBe(101n);
    fixture.store.close();
  });

  test('the Scheduler and a catch-up pass never enqueue a conversation twice', async () => {
    const fixture = await setup(true);
    const clock = fixedClock();
    const startedAt = clock();
    fixture.scheduler.start(startedAt);
    try {
      const updates: Update[] = [];
      for (let index = 1; index <= 20; index += 1) {
        updates.push(textUpdate(index, index, 7, FIRST_CHAT_ID));
        updates.push(textUpdate(100 + index, index, 7, SECOND_CHAT_ID));
      }
      const result = await drain(fixture, fakeApi(updates), { now: clock });
      expect(result.invocationIds).toHaveLength(2);

      await sleepUntil(fixture, () => count(fixture, 'buckets') === 2n && settled(fixture));
      // One catch-up bucket and one invocation per conversation, even though
      // the Scheduler was already looping while the pass committed.
      expect(
        fixture.store.db
          .prepare<[], { telegram_chat_id: bigint; invocations: bigint; buckets: bigint }>(
            `SELECT c.telegram_chat_id, COUNT(DISTINCT i.id) AS invocations, COUNT(DISTINCT ib.bucket_id) AS buckets
             FROM invocations i
             JOIN invocation_buckets ib ON ib.invocation_id = i.id
             JOIN conversations v ON v.id = i.conversation_id
             JOIN chats c ON c.id = v.chat_id
             GROUP BY c.telegram_chat_id ORDER BY c.telegram_chat_id`,
          )
          .all(),
      ).toEqual([
        { telegram_chat_id: BigInt(FIRST_CHAT_ID), invocations: 1n, buckets: 1n },
        { telegram_chat_id: BigInt(SECOND_CHAT_ID), invocations: 1n, buckets: 1n },
      ]);
      expect(
        fixture.store.db.prepare<[], { state: string }>('SELECT DISTINCT state FROM invocations ORDER BY state').all(),
      ).toEqual([{ state: 'completed' }]);

      // A redelivery of the same backlog must not create a second invocation.
      const retry = await drain(fixture, fakeApi(updates), { now: clock });
      expect(retry).toMatchObject({ storedMessages: 0 });
      expect(retry.invocationIds).toHaveLength(0);
      expect(count(fixture, 'invocations')).toBe(2n);
    } finally {
      await fixture.scheduler.stop();
      fixture.store.close();
    }
  });
});

function settled(fixture: Fixture): boolean {
  const rows = fixture.store.db.prepare<[], { state: string }>('SELECT state FROM invocations').all();
  return rows.length === 2 && rows.every((row) => row.state !== 'queued' && row.state !== 'running');
}

async function sleepUntil(_fixture: Fixture, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for runtime catch-up work');
    }
    await sleep(10);
  }
}
