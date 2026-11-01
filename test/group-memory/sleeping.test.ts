import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { appState, buckets, chatPause, invocations, modelCalls } from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

function service(f: Awaited<ReturnType<typeof groupMemoryFixture>>): SleepingService {
  return new SleepingService({
    store: f.store,
    configStore: f.configStore,
    secrets: f.secrets,
    isHostReady: () => true,
  });
}

function answer(f: Awaited<ReturnType<typeof groupMemoryFixture>>, lastMessageId = 4005): void {
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

test('a finished local day is consolidated and the watermark advances', async () => {
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
    expect(f.groupMemory.state(f.chatId)?.consolidatedThroughMessageId).toBe(4114n);
    expect(f.store.orm.select().from(modelCalls).where(eq(modelCalls.state, 'success')).all()).toHaveLength(1);
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
    f.store.orm.update(modelCalls).set({ state: 'error' }).where(eq(modelCalls.state, 'success')).run();

    const current = f.configStore.current();
    f.configStore.publish({
      config: {
        ...current.config,
        telegram: {
          ...current.config.telegram,
          chats: current.config.telegram.chats.map((chat) => ({ ...chat, group_memory: { enabled: false } })),
        },
      },
      hash: current.hash,
      models: current.models,
      visionModel: current.visionModel,
    });
    expect(await worker.tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('the per-tick cap counts failed model calls, not only successful commits', async () => {
  const f = await groupMemoryFixture({ faux: true, extraChatIds: [-1001, -1002, -1003] });
  try {
    for (const chat of [f, ...f.extraChats]) {
      seedMessage(f.store, chat, {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'hello',
      });
    }
    // A provider outage: every call returns something unusable.
    f.faux?.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('not json')));
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(0);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('a Chat paused while an earlier batch was running starts no model call', async () => {
  const f = await groupMemoryFixture({ faux: true, extraChatIds: [-1001] });
  const second = f.extraChats[0];
  if (second === undefined) {
    throw new Error('Missing extra Chat');
  }
  try {
    for (const chat of [f, second]) {
      seedMessage(f.store, chat, {
        telegramMessageId: 4005,
        date: new Date('2026-10-01T10:00:00.000Z'),
        text: 'hello',
      });
    }
    f.faux?.setResponses([
      () => {
        // While the first Chat's call is in flight, the operator pauses the second.
        f.store.orm.insert(chatPause).values({ chatId: second.chatId, pausedAt: '2026-10-02T12:00:00.000Z' }).run();
        return fauxAssistantMessage('{"events":[]}');
      },
      fauxAssistantMessage('{"events":[]}'),
    ]);
    expect(await service(f).tick(new Date('2026-10-02T12:00:00.000Z'))).toBe(1);
    expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(1);
    expect(f.groupMemory.state(second.chatId)).toBeUndefined();
  } finally {
    await f.close();
  }
});
