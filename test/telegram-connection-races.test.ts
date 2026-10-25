/**
 * Overlapping connection attempts and interrupted backlog drains.
 *
 * A network retry runs beside the manager's request queue, so a newer token can
 * start connecting while a superseded attempt is still inside a call that
 * ignores its abort signal. Whatever the stale attempt does when it wakes up
 * must leave the live instance alone. A cold drain is resumable by design, so
 * a connection must never go live while its marker still stands.
 */
import { eq } from 'drizzle-orm';
import { HttpError } from 'grammy';
import { afterEach, expect, test } from 'vitest';
import type { TelegramConnectionHooks } from '../src/adapters/local-monolith/telegram-connection.ts';
import { STARTUP_CATCH_UP_STATE_KEY } from '../src/orchestration/invocation-queue.ts';
import { appState } from '../src/store/schema.ts';
import {
  type ConnectionFixture,
  closeConnectionFixtures,
  identityOf,
  openConnectionFixture,
  waitUntil,
} from './telegram-connection-fixtures.ts';

afterEach(async () => {
  await closeConnectionFixtures();
});

const network = (): HttpError => new HttpError('Network request for getMe failed!', new Error('ECONNREFUSED'));

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const startupMarker = (fixture: ConnectionFixture): string | undefined =>
  fixture.store.orm
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, STARTUP_CATCH_UP_STATE_KEY))
    .get()?.value;

const writeStartupMarker = (fixture: ConnectionFixture): void => {
  fixture.store.orm
    .insert(appState)
    .values({
      key: STARTUP_CATCH_UP_STATE_KEY,
      value: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .run();
};

const clearStartupMarker = (fixture: ConnectionFixture): void => {
  fixture.store.orm.delete(appState).where(eq(appState.key, STARTUP_CATCH_UP_STATE_KEY)).run();
};

test('a superseded retry that wakes up late never tears down the live replacement', async () => {
  const staleSync = deferred();
  const fixture = await openConnectionFixture({
    withStickers: true,
    // The first sticker worker belongs to the stale retry; its sync is the
    // non-cancellable call the replacement overtakes.
    stickerSync: (index) => (index === 0 ? staleSync.promise : undefined),
    getMe: [
      () => Promise.reject(network()),
      () => Promise.resolve(identityOf('telegram-secret')),
      () => Promise.resolve(identityOf('next-token')),
    ],
  });
  await fixture.manager.start(fixture.hooks);
  // The retry got past getMe and is stuck in the sticker sync.
  await waitUntil(() => fixture.stickers.length === 1);

  fixture.manager.applyToken({ kind: 'token', token: 'next-token' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '43');
  expect(fixture.holder.current?.token).toBe('next-token');
  const live = fixture.stickers[1];
  expect(live?.started).toBe(1);

  // The stale attempt resumes, sees its abort and abandons its own instance.
  staleSync.resolve();
  await waitUntil(() => fixture.bots[1]?.stopped === true);
  await fixture.manager.whenIdle();

  expect(fixture.holder.current?.token).toBe('next-token');
  expect(fixture.manager.stickers).toBe(live);
  expect(live?.stops).toBe(0);
  // The stale worker never started, so nothing of it keeps running.
  expect(fixture.stickers[0]?.started).toBe(0);
  expect(fixture.status()).toMatchObject({ status: 'connected', bot: { id: '43' } });
  expect(fixture.readiness.isReady()).toBe(true);
});

test('a retry attempt that throws is logged instead of rejecting unobserved', async () => {
  let ingestions = 0;
  const fixture = await openConnectionFixture({
    getMe: [() => Promise.reject(network()), () => Promise.resolve(identityOf('telegram-secret'))],
    createIngestion: (me) => {
      ingestions += 1;
      // Only the retry gets this far: the first attempt failed at getMe.
      throw new Error(`ingestion for ${me.id} is broken`);
    },
  });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status()).toMatchObject({ status: 'network_error' });

  await waitUntil(() =>
    fixture.events.some(
      (entry) => entry.event === 'telegram_connection_failed' && entry.error === 'ingestion for 42 is broken',
    ),
  );
  expect(ingestions).toBe(1);
  // The attempt ended, so the transition it held is released again.
  await waitUntil(() => !fixture.readiness.isReady() && fixture.holder.current === undefined);
  expect(fixture.bots.some((bot) => bot.started)).toBe(false);
});

test('a cold drain cancelled by a newer token is resumed by the next connection', async () => {
  let fixture: ConnectionFixture | undefined;
  let coldCalls = 0;
  const hooks = (base: TelegramConnectionHooks): TelegramConnectionHooks => ({
    ...base,
    coldCatchUp: async (_api, _ingestion, signal) => {
      coldCalls += 1;
      if (fixture === undefined) {
        throw new Error('fixture not ready');
      }
      if (coldCalls === 1) {
        writeStartupMarker(fixture);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      clearStartupMarker(fixture);
    },
  });
  fixture = await openConnectionFixture({
    getMe: [
      () => Promise.resolve(identityOf('telegram-secret')),
      () => Promise.resolve({ id: 77, first_name: 'Next', username: 'next_bot' }),
    ],
  });
  const starting = fixture.manager.start(hooks(fixture.hooks));
  await waitUntil(() => coldCalls === 1);

  fixture.manager.applyToken({ kind: 'token', token: 'next-token' });
  await starting;
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '77');

  // The replacement drained with the cold contract, which owns the marker,
  // instead of going live past it with a bounded runtime pass.
  expect(coldCalls).toBe(2);
  expect(fixture.runtimeCatchUps).toHaveLength(0);
  expect(startupMarker(fixture)).toBeUndefined();
});

test('a cold drain that fails mid-way is retried before the instance goes live', async () => {
  let fixture: ConnectionFixture | undefined;
  let coldCalls = 0;
  fixture = await openConnectionFixture({
    getMe: [() => Promise.resolve(identityOf('telegram-secret')), () => Promise.resolve(identityOf('telegram-secret'))],
  });
  const hooks: TelegramConnectionHooks = {
    ...fixture.hooks,
    coldCatchUp: async () => {
      coldCalls += 1;
      if (fixture === undefined) {
        throw new Error('fixture not ready');
      }
      if (coldCalls === 1) {
        writeStartupMarker(fixture);
        throw network();
      }
      clearStartupMarker(fixture);
    },
  };
  await fixture.manager.start(hooks);

  // The failed drain did not go live: no polling, no ready gate.
  expect(fixture.bots[0]?.started).toBe(false);
  await fixture.waitForStatus((state) => state.status === 'connected');

  expect(coldCalls).toBe(2);
  expect(fixture.runtimeCatchUps).toHaveLength(0);
  expect(startupMarker(fixture)).toBeUndefined();
  expect(fixture.bots[0]?.started).toBe(false);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(fixture.bots.filter((bot) => bot.started && !bot.stopped)).toHaveLength(1);
});
