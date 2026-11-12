import { fauxAssistantMessage, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import {
  appState,
  buckets,
  chatPause,
  groupMemoryRuns,
  invocations,
  modelCalls,
} from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

type Fixture = Awaited<ReturnType<typeof groupMemoryFixture>>;

function service(f: Fixture): SleepingService {
  return new SleepingService({
    store: f.store,
    configStore: f.configStore,
    secrets: f.secrets,
    isHostReady: () => true,
  });
}

function answer(f: Fixture, lastMessageId = 4005): void {
  const faux = f.faux;
  if (faux === undefined) {
    throw new Error('faux provider missing');
  }
  faux.setResponses([
    fauxAssistantMessage(
      `{"events":[{"summary":"Natu and tcdw discussed eSIM prices","first_message_id":4005,"last_message_id":${lastMessageId}}]}`,
    ),
  ]);
}

function promptOf(context: Parameters<FauxResponseFactory>[0]): string {
  const first = context.messages.find((message) => message.role === 'user');
  return typeof first?.content === 'string' ? first.content : '';
}

/** The message ids a consolidation prompt showed the model. */
function promptIds(prompt: string): number[] {
  return [...prompt.matchAll(/^\[(\d+)/gm)].map((match) => Number(match[1]));
}

/** A well-behaved model: one event spanning every message it was shown, labelled with its day. */
function summarizeAll(seen?: number[][]): FauxResponseFactory {
  return (context) => {
    const prompt = promptOf(context);
    const ids = promptIds(prompt);
    seen?.push(ids);
    const day = /Chat-local day: (\S+)/.exec(prompt)?.[1] ?? '';
    return fauxAssistantMessage(
      JSON.stringify({
        events: [
          { summary: `events of ${day}`, first_message_id: Math.min(...ids), last_message_id: Math.max(...ids) },
        ],
      }),
    );
  };
}

function respond(f: Fixture, steps: Parameters<NonNullable<Fixture['faux']>['setResponses']>[0]): void {
  if (f.faux === undefined) {
    throw new Error('faux provider missing');
  }
  f.faux.setResponses(steps);
}

function publishSwitch(f: Fixture, enabled: boolean): void {
  const current = f.configStore.current();
  f.configStore.publish({
    config: {
      ...current.config,
      telegram: {
        ...current.config.telegram,
        chats: current.config.telegram.chats.map((chat) => ({
          ...chat,
          group_memory: enabled ? { enabled: true, idle_minutes: 30 } : { enabled: false },
        })),
      },
    },
    hash: current.hash,
    models: current.models,
    visionModel: current.visionModel,
  });
}

/** Two old days, yesterday and early today: the shape of a Chat that fell behind. */
function seedBacklog(f: Fixture): void {
  for (const [id, date] of [
    [100, '2026-10-01T10:00:00.000Z'],
    [200, '2026-10-02T10:00:00.000Z'],
    [900, '2026-10-09T10:00:00.000Z'],
    [1000, '2026-10-10T01:00:00.000Z'],
  ] as const) {
    seedMessage(f.store, f, { telegramMessageId: id, date: new Date(date), text: `message ${id}` });
  }
}

const BACKLOG_NOW = new Date('2026-10-10T12:00:00.000Z');

test('a finished local day is consolidated and the live lane advances', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'eSIM 多少钱？',
      senderName: 'Natu',
    });
    seedMessage(f.store, f, {
      telegramMessageId: 4114,
      date: new Date('2026-10-01T10:05:00.000Z'),
      text: '大概 50 块',
      senderName: 'tcdw',
    });
    answer(f, 4114);
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(1);
    expect(f.groupMemory.list(f.chatId, { day: '2026-10-01' })).toEqual([
      expect.objectContaining({
        summary: 'Natu and tcdw discussed eSIM prices',
        firstMessageId: 4005n,
        lastMessageId: 4114n,
      }),
    ]);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(4114n);
    expect(f.store.orm.select().from(modelCalls).where(eq(modelCalls.state, 'success')).all()).toHaveLength(1);
    expect(f.store.orm.select().from(groupMemoryRuns).all()).toEqual([
      expect.objectContaining({
        chatId: f.chatId,
        lane: 'live',
        day: '2026-10-01',
        firstMessageId: 4005n,
        throughMessageId: 4114n,
        messages: 2n,
        state: 'success',
        events: 1n,
        modelCalls: 1n,
      }),
    ]);
  } finally {
    await f.close();
  }
});

test('switching group memory on skips the stored history', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    // The switch is turned on in a Chat that already has history.
    f.groupMemory.deactivate([f.chatId]);
    seedMessage(f.store, f, { telegramMessageId: 4005, date: new Date('2026-10-01T10:00:00.000Z'), text: 'old' });
    const worker = service(f);
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(0);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(4005n);

    seedMessage(f.store, f, { telegramMessageId: 4006, date: new Date('2026-10-02T13:00:00.000Z'), text: 'new' });
    const seen: number[][] = [];
    respond(f, [summarizeAll(seen)]);
    expect(await worker.tick(new Date('2026-10-03T12:00:00.000Z'))).toBe(1);
    expect(seen).toEqual([[4006]]);
  } finally {
    await f.close();
  }
});

test('switching group memory off and on again skips the messages in between', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, { telegramMessageId: 4005, date: new Date('2026-10-01T10:00:00.000Z'), text: 'kept' });
    const seen: number[][] = [];
    respond(f, [summarizeAll(seen), summarizeAll(seen)]);
    const worker = service(f);
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(1);

    publishSwitch(f, false);
    expect(await worker.tick(new Date('2026-10-02T12:01:00.000Z'))).toBe(0);
    expect(f.groupMemory.lanes(f.chatId)).toEqual([]);
    seedMessage(f.store, f, { telegramMessageId: 4006, date: new Date('2026-10-02T13:00:00.000Z'), text: 'while off' });

    publishSwitch(f, true);
    expect(await worker.tick(new Date('2026-10-03T12:00:00.000Z'))).toBe(0);
    seedMessage(f.store, f, { telegramMessageId: 4007, date: new Date('2026-10-03T13:00:00.000Z'), text: 'after' });
    expect(await worker.tick(new Date('2026-10-04T12:00:00.000Z'))).toBe(1);
    expect(seen).toEqual([[4005], [4007]]);
    expect(f.groupMemory.list(f.chatId).map((entry) => entry.day)).toEqual(['2026-10-03', '2026-10-01']);
  } finally {
    await f.close();
  }
});

test('a backlog older than yesterday moves to a backfill lane while recent days keep up', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedBacklog(f);
    const seen: number[][] = [];
    respond(
      f,
      Array.from({ length: 4 }, () => summarizeAll(seen)),
    );
    const worker = service(f);
    expect(await worker.tick(BACKLOG_NOW)).toBe(2);
    // The first tick already reached yesterday through the live lane.
    expect(
      f.groupMemory.lanes(f.chatId).map((lane) => [lane.lane, lane.throughMessageId, lane.untilMessageId]),
    ).toEqual([
      ['live', 900n, null],
      ['backfill', 100n, 200n],
    ]);
    expect(await worker.tick(new Date(BACKLOG_NOW.getTime() + 60_000))).toBe(2);
    // The backfill lane ends where the live lane began: every message once, none twice.
    expect(seen.flat().toSorted((a, b) => a - b)).toEqual([100, 200, 900, 1000]);
    expect(f.groupMemory.lanes(f.chatId).map((lane) => [lane.lane, lane.throughMessageId])).toEqual([['live', 1000n]]);
    expect(f.groupMemory.list(f.chatId).map((entry) => entry.day)).toEqual([
      '2026-10-10',
      '2026-10-09',
      '2026-10-02',
      '2026-10-01',
    ]);
  } finally {
    await f.close();
  }
});

test('a failing backfill batch backs off alone and the live lane keeps going', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedBacklog(f);
    const backfillOrValid: FauxResponseFactory = (context, options, state, model) =>
      promptOf(context).includes('Chat-local day: 2026-10-01')
        ? fauxAssistantMessage('not json')
        : summarizeAll()(context, options, state, model);
    respond(
      f,
      Array.from({ length: 6 }, () => backfillOrValid),
    );
    const worker = service(f);
    expect(await worker.tick(BACKLOG_NOW)).toBe(1);
    expect(f.groupMemory.lane(f.chatId, 'backfill')).toMatchObject({
      throughMessageId: 0n,
      errorCode: 'group_memory_invalid_output',
      consecutiveFailures: 1n,
    });
    expect(f.groupMemory.lane(f.chatId, 'live')).toMatchObject({ throughMessageId: 900n, errorCode: null });
    // Within the backoff the live lane still consolidates today; the backfill lane waits.
    expect(await worker.tick(new Date(BACKLOG_NOW.getTime() + 60_000))).toBe(1);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(1000n);
    const failed = f.store.orm.select().from(groupMemoryRuns).where(eq(groupMemoryRuns.state, 'error')).all();
    expect(failed).toEqual([
      expect.objectContaining({
        lane: 'backfill',
        day: '2026-10-01',
        modelCalls: 2n,
        errorCode: 'group_memory_invalid_output',
        errorDetail: 'The tool model did not return a JSON object',
      }),
    ]);
  } finally {
    await f.close();
  }
});

test('a busy Chat holds its live lane but not its backfill lane', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedBacklog(f);
    const bucket = f.store.orm
      .insert(buckets)
      .values({
        conversationId: f.conversationId,
        state: 'collecting',
        firstReceivedAt: '2026-10-10T11:59:00.000Z',
        deadlineAt: '2026-10-10T12:00:15.000Z',
        createdAt: '2026-10-10T11:59:00.000Z',
        updatedAt: '2026-10-10T11:59:00.000Z',
      })
      .returning({ id: buckets.id })
      .get();
    expect(bucket).toBeDefined();
    const seen: number[][] = [];
    respond(f, [summarizeAll(seen), summarizeAll(seen)]);
    expect(await service(f).tick(BACKLOG_NOW)).toBe(1);
    expect(seen).toEqual([[100]]);
    expect(f.groupMemory.lane(f.chatId, 'live')).toMatchObject({ throughMessageId: 200n, lastAttemptAt: null });
  } finally {
    await f.close();
  }
});

test('lanes of different Chats run their model calls in parallel', async () => {
  const f = await groupMemoryFixture({ faux: true, extraChatIds: [-1001, -1002] });
  try {
    for (const chat of [f, ...f.extraChats]) {
      seedMessage(f.store, chat, {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'hello',
      });
    }
    let inFlight = 0;
    let peak = 0;
    const slow: FauxResponseFactory = async (context, options, state, model) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return summarizeAll()(context, options, state, model);
    };
    respond(f, [slow, slow, slow]);
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(3);
    expect(peak).toBe(3);
  } finally {
    await f.close();
  }
});

test('a running local day waits for the idle window', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-02T11:31:00.000Z'),
      text: 'still talking',
    });
    answer(f);
    const worker = service(f);
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.groupMemory.list(f.chatId)).toEqual([]);
    expect(await worker.tick(new Date('2026-10-02T12:02:00.000Z'))).toBe(1);
    expect(f.groupMemory.list(f.chatId)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a Chat with queued or running work is skipped', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'hello',
    });
    const bucket = f.store.orm
      .insert(buckets)
      .values({
        conversationId: f.conversationId,
        state: 'queued',
        firstReceivedAt: '2026-10-01T10:00:00.000Z',
        deadlineAt: '2026-10-01T10:00:15.000Z',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      })
      .returning({ id: buckets.id })
      .get();
    if (bucket === undefined) {
      throw new Error('bucket insert returned no row');
    }
    f.store.orm
      .insert(invocations)
      .values({
        bucketId: bucket.id,
        conversationId: f.conversationId,
        state: 'queued',
        configHash: 'test',
        promptVersion: 1n,
        createdAt: '2026-10-01T10:00:00.000Z',
      })
      .run();
    answer(f);
    const worker = service(f);
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.groupMemory.list(f.chatId)).toEqual([]);
    f.store.orm.update(invocations).set({ state: 'completed' }).where(eq(invocations.state, 'queued')).run();
    f.store.orm.update(buckets).set({ state: 'completed' }).where(eq(buckets.state, 'queued')).run();
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(1);
  } finally {
    await f.close();
  }
});

test('a paused Chat starts no model call until it resumes', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'hello',
    });
    answer(f);
    const worker = service(f);
    f.store.orm.insert(chatPause).values({ chatId: f.chatId, pausedAt: '2026-10-01T10:00:00.000Z' }).run();
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.groupMemory.list(f.chatId)).toEqual([]);
    f.store.orm.delete(chatPause).run();
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(1);
  } finally {
    await f.close();
  }
});

test('disabled Chats and a global budget sleep start no model call', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    seedMessage(f.store, f, {
      telegramMessageId: 4005,
      date: new Date('2026-10-01T10:00:00.000Z'),
      text: 'hello',
    });
    answer(f);
    const worker = service(f);
    f.store.orm
      .insert(appState)
      .values({ key: 'bot_sleep_until', value: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
      .run();
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    f.store.orm.delete(appState).where(eq(appState.key, 'bot_sleep_until')).run();

    publishSwitch(f, false);
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(0);
    expect(f.groupMemory.lanes(f.chatId)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('the per-tick budget counts failed batches and their repair calls', async () => {
  const extraChatIds = [-1001, -1002, -1003, -1004, -1005, -1006, -1007, -1008];
  const f = await groupMemoryFixture({ faux: true, extraChatIds });
  try {
    for (const chat of [f, ...f.extraChats]) {
      seedMessage(f.store, chat, {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'hello',
      });
    }
    // Every reply is unusable, the repair call included.
    respond(
      f,
      Array.from({ length: 18 }, () => fauxAssistantMessage('not json')),
    );
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.store.orm.select().from(groupMemoryRuns).all()).toHaveLength(8);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(16);
    const untouched = [f, ...f.extraChats].filter(
      (chat) => f.groupMemory.lane(chat.chatId, 'live')?.lastAttemptAt === null,
    );
    expect(untouched).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a Chat paused while earlier batches were running starts no model call', async () => {
  // One more Chat than parallel slots: the last one only starts after a slot frees.
  const f = await groupMemoryFixture({ faux: true, extraChatIds: [-1001, -1002, -1003, -1004] });
  const last = f.extraChats.at(-1);
  if (last === undefined) {
    throw new Error('Missing extra Chat');
  }
  try {
    for (const chat of [f, ...f.extraChats]) {
      seedMessage(f.store, chat, {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'hello',
      });
    }
    // While the first batches are in flight, the operator pauses the last Chat;
    // whichever reply is produced first does it, before any slot frees.
    const pauseLast: FauxResponseFactory = () => {
      f.store.orm
        .insert(chatPause)
        .values({ chatId: last.chatId, pausedAt: '2026-10-02T12:00:00.000Z' })
        .onConflictDoNothing()
        .run();
      return fauxAssistantMessage('{"events":[]}');
    };
    respond(
      f,
      Array.from({ length: 5 }, () => pauseLast),
    );
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(4);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(4);
    expect(f.groupMemory.lane(last.chatId, 'live')?.lastAttemptAt).toBeNull();
  } finally {
    await f.close();
  }
});
