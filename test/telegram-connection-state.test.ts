/**
 * The Telegram connection manager's state machine.
 *
 * Covers the migration table: a running instance is left alone for its own
 * token, replaced for another one and stopped into disabled or configuration
 * errors; a stopped one starts only for a token. It also covers the two ways a
 * live stream reports trouble (401/409 reject polling, every other failure is a
 * network error the loop retries itself) and the retry/abort rules that keep a
 * slow `getMe` from blocking or leaking.
 */
import { GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { afterEach, expect, test } from 'vitest';
import {
  closeConnectionFixtures,
  identityOf,
  openConnectionFixture,
  waitUntil,
} from './telegram-connection-fixtures.ts';

afterEach(async () => {
  await closeConnectionFixtures();
});

const apiError = (errorCode: number, description: string, retryAfter?: number): ApiError => ({
  ok: false,
  error_code: errorCode,
  description,
  ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
});

const unauthorized = (): GrammyError =>
  new GrammyError('Call to getMe failed!', apiError(401, 'Unauthorized'), 'getMe', {});
const conflict = (): GrammyError => new GrammyError('Call to start failed!', apiError(409, 'Conflict'), 'getMe', {});
const network = (): HttpError => new HttpError('Network request for getMe failed!', new Error('ECONNREFUSED'));

test('a token rejected on cold start is a configuration state, not a startup failure', async () => {
  const fixture = await openConnectionFixture({ getMe: [() => Promise.reject(unauthorized())] });
  await fixture.manager.start(fixture.hooks);

  expect(fixture.status()).toMatchObject({ status: 'config_error', reason: 'unauthorized' });
  expect(fixture.status().bot).toBeUndefined();
  expect(fixture.readiness.isReady()).toBe(false);
  expect(fixture.holder.current).toBeUndefined();
  expect(fixture.bots).toHaveLength(1);
  expect(fixture.bots[0]?.started).toBe(false);
  expect(fixture.bots[0]?.commandsRegistered).toBe(false);
});

test('an unreachable Telegram is reported while the first attempt fails, then reconnects on retry', async () => {
  const fixture = await openConnectionFixture({
    getMe: [() => Promise.reject(network()), () => Promise.resolve(identityOf('telegram-secret'))],
  });
  await fixture.manager.start(fixture.hooks);

  // The first attempt failing must not delay the rest of startup.
  expect(fixture.status()).toMatchObject({ status: 'network_error' });
  expect(fixture.status().bot).toBeUndefined();
  expect(fixture.readiness.isReady()).toBe(false);

  await fixture.waitForStatus((state) => state.status === 'connected');
  expect(fixture.status().bot).toEqual({ id: '42', username: 'telegram-secret_bot' });
  expect(fixture.readiness.isReady()).toBe(true);
  expect(fixture.holder.identity?.id).toBe(42);
  expect(fixture.bots).toHaveLength(2);
  expect(fixture.bots[0]?.started).toBe(false);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(fixture.bots.filter((bot) => bot.started && !bot.stopped)).toHaveLength(1);
  expect(fixture.sleeps).toEqual([1]);
  // The first cold start never polled, so the initialized marker is written by
  // the attempt that finally connected (still a cold start for the drop rule).
  expect(fixture.events.some((entry) => entry.event === 'telegram_connected')).toBe(true);
});

test('429 waits for Telegram and the exponential backoff is capped at a minute', async () => {
  const limited = new GrammyError('Call to getMe failed!', apiError(429, 'Too Many Requests', 120), 'getMe', {});
  const fixture = await openConnectionFixture({
    getMe: [() => Promise.reject(limited), () => Promise.resolve(identityOf('telegram-secret'))],
  });
  await fixture.manager.start(fixture.hooks);
  await fixture.waitForStatus((state) => state.status === 'connected');
  expect(fixture.sleeps).toEqual([60_000]);

  const attempts: (() => Promise<unknown>)[] = Array.from({ length: 20 }, () => () => Promise.reject(network()));
  attempts.push(() => Promise.resolve(identityOf('telegram-secret')));
  const slow = await openConnectionFixture({ getMe: attempts });
  await slow.manager.start(slow.hooks);
  await slow.waitForStatus((state) => state.status === 'connected');
  expect(Math.max(...slow.sleeps)).toBe(60_000);
  expect(slow.sleeps.every((delay) => delay <= 60_000)).toBe(true);
  expect(slow.sleeps.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
});

test('a running instance ignores its own token and replaces any other one', async () => {
  const fixture = await openConnectionFixture({
    getMe: [
      () => Promise.resolve(identityOf('telegram-secret')),
      () => Promise.resolve({ id: 99, first_name: 'Other', username: 'other_bot' }),
    ],
  });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status().status).toBe('connected');

  fixture.manager.applyToken({ kind: 'token', token: 'telegram-secret' });
  await fixture.manager.whenIdle();
  expect(fixture.bots).toHaveLength(1);
  expect(fixture.bots[0]?.stopCount).toBe(0);

  fixture.manager.applyToken({ kind: 'token', token: 'another-token' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '99');
  expect(fixture.bots).toHaveLength(2);
  expect(fixture.bots[0]?.stopped).toBe(true);
  expect(fixture.bots[0]?.stopCount).toBe(1);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(fixture.bots.filter((bot) => bot.started && !bot.stopped)).toHaveLength(1);
  expect(fixture.holder.current?.token).toBe('another-token');
  // A replacement is a runtime start: it never drops backlog for a new token.
  expect(fixture.bots[0]?.webhookOptions).toEqual({ drop_pending_updates: true });
  expect(fixture.bots[1]?.webhookOptions).toEqual({});
});

test('the full disabled/configuration-error migration table', async () => {
  const identities = [
    identityOf('telegram-secret'),
    { id: 51, first_name: 'Token B', username: 'token_b_bot' },
    { id: 52, first_name: 'Token C', username: 'token_c_bot' },
  ];
  const fixture = await openConnectionFixture({ getMe: identities.map((identity) => () => Promise.resolve(identity)) });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status().status).toBe('connected');

  // running -> empty: stop and become disabled.
  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  await fixture.manager.whenIdle();
  expect(fixture.holder.current).toBeUndefined();
  expect(fixture.readiness.isReady()).toBe(false);
  expect(fixture.bots[0]?.stopped).toBe(true);

  // disabled -> empty: only the state is recorded, no instance is built.
  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.manager.whenIdle();
  expect(fixture.bots).toHaveLength(1);

  // disabled -> plaintext: start.
  fixture.manager.applyToken({ kind: 'token', token: 'token-b' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '51');
  expect(fixture.bots).toHaveLength(2);

  // running -> unreadable: stop and report the configuration error.
  fixture.manager.applyToken({ kind: 'unreadable', message: 'Key jar has no entry' });
  await fixture.waitForStatus((state) => state.status === 'config_error');
  await fixture.manager.whenIdle();
  expect(fixture.status()).toMatchObject({ reason: 'token_unreadable' });
  expect(fixture.holder.current).toBeUndefined();
  expect(fixture.bots[1]?.stopped).toBe(true);

  // config_error -> plaintext: start again.
  fixture.manager.applyToken({ kind: 'token', token: 'token-c' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '52');
  expect(fixture.bots).toHaveLength(3);

  // running -> empty, then config_error -> empty.
  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  fixture.manager.applyToken({ kind: 'unreadable', message: 'Key jar has no entry' });
  await fixture.waitForStatus((state) => state.status === 'config_error');
  await fixture.manager.whenIdle();
  expect(fixture.bots).toHaveLength(3);
  expect(fixture.holder.current).toBeUndefined();
});

test('401 and 409 from long polling stop the instance without rejecting the process', async () => {
  for (const error of [unauthorized(), conflict()]) {
    const fixture = await openConnectionFixture({ startError: () => error });
    await fixture.manager.start(fixture.hooks);
    // `start` resolves after the connect; the stream's rejection arrives right
    // after it and must enter the configuration-error stop path, not escape.
    await fixture.waitForStatus((state) => state.status === 'config_error');
    await fixture.manager.whenIdle();
    expect(fixture.status()).toMatchObject({
      reason: error.error_code === 401 ? 'unauthorized' : 'conflict',
    });
    expect(fixture.holder.current).toBeUndefined();
    expect(fixture.readiness.isReady()).toBe(false);
    expect(fixture.bots[0]?.stopped).toBe(true);
    expect(fixture.events.some((entry) => entry.event === 'telegram_polling_rejected')).toBe(true);
    await closeConnectionFixtures();
  }
});

test('a failed getUpdates is a live network error and the next success heals it', async () => {
  const fixture = await openConnectionFixture({ getMe: [() => Promise.resolve(identityOf('telegram-secret'))] });
  await fixture.manager.start(fixture.hooks);
  const bot = fixture.bots[0];
  if (bot === undefined) {
    throw new Error('no bot');
  }

  await expect(bot.failPolling(new HttpError('getUpdates failed', new Error('offline')))).rejects.toThrow(
    'getUpdates failed',
  );
  expect(fixture.status()).toMatchObject({ status: 'network_error', bot: { id: '42' } });
  // A running instance stays usable: only reachability is in question.
  expect(fixture.readiness.isReady()).toBe(true);
  expect(bot.stopped).toBe(false);

  await bot.getUpdates();
  expect(fixture.status()).toMatchObject({ status: 'connected', bot: { id: '42' } });
  const events = fixture.events.map((entry) => entry.event);
  expect(events).toContain('telegram_network_error');
  expect(events).toContain('telegram_reconnected');
});

test('a newer token aborts the backoff of a connection that never came up', async () => {
  const delays: number[] = [];
  const blockUntilAbort = (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      delays.push(_ms);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const fixture = await openConnectionFixture({
    token: 'absent',
    getMe: [() => Promise.reject(network()), () => Promise.resolve(identityOf('telegram-secret'))],
    sleep: blockUntilAbort,
  });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status().status).toBe('disabled');

  fixture.manager.applyToken({ kind: 'token', token: 'stale-token' });
  await fixture.waitForStatus((state) => state.status === 'network_error');
  expect(fixture.bots).toHaveLength(1);

  fixture.manager.applyToken({ kind: 'token', token: 'telegram-secret' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '42');
  expect(fixture.bots).toHaveLength(2);
  expect(fixture.bots[0]?.started).toBe(false);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(fixture.bots.filter((bot) => bot.started && !bot.stopped)).toHaveLength(1);
  expect(delays).toEqual([1]);
});

test('a newer token aborts a cold backlog drain before the stream starts', async () => {
  const fixture = await openConnectionFixture({
    getMe: [
      () => Promise.resolve(identityOf('telegram-secret')),
      () => Promise.resolve({ id: 77, first_name: 'Next', username: 'next_bot' }),
    ],
  });
  let drainAborted = false;
  const hooks = {
    ...fixture.hooks,
    coldCatchUp: (_api: unknown, _ingestion: unknown, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            drainAborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  };
  const starting = fixture.manager.start(hooks);
  await waitUntil(() => fixture.bots.length === 1 && fixture.bots[0]?.webhookOptions !== undefined);

  fixture.manager.applyToken({ kind: 'token', token: 'next-token' });
  await starting;
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '77');

  expect(drainAborted).toBe(true);
  expect(fixture.bots[0]?.started).toBe(false);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(fixture.holder.current?.token).toBe('next-token');
});

test('a configured token that cannot be read starts as a configuration error', async () => {
  const fixture = await openConnectionFixture({ token: 'unreadable' });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status()).toMatchObject({ status: 'config_error', reason: 'token_unreadable' });
  expect(fixture.bots).toHaveLength(0);
  expect(fixture.holder.current).toBeUndefined();
  expect(fixture.events.some((entry) => entry.event === 'telegram_token_unreadable')).toBe(true);
});

test('logs never contain a plaintext token', async () => {
  const secret = 'extremely-secret-bot-token';
  const fixture = await openConnectionFixture({
    token: 'absent',
    getMe: [() => Promise.reject(new HttpError(`failed for ${secret}`, new Error(secret)))],
    sleep: (_ms, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  });
  await fixture.manager.start(fixture.hooks);
  fixture.manager.applyToken({ kind: 'token', token: secret });
  await fixture.waitForStatus((state) => state.status === 'network_error');
  const logged = JSON.stringify(fixture.events);
  expect(logged).not.toContain(secret);
  expect(logged).toContain('[REDACTED]');
});

test('the sticker index follows the instance', async () => {
  const fixture = await openConnectionFixture({
    withStickers: true,
    getMe: [
      () => Promise.resolve(identityOf('telegram-secret')),
      () => Promise.resolve({ id: 88, first_name: 'Two', username: 'two_bot' }),
    ],
  });
  await fixture.manager.start(fixture.hooks);
  expect(fixture.stickers[0]).toMatchObject({ synced: 1, started: 1, stops: 0 });
  expect(fixture.manager.stickers).toBeDefined();

  fixture.manager.applyToken({ kind: 'token', token: 'second-token' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '88');
  expect(fixture.stickers[0]?.stops).toBe(1);
  expect(fixture.stickers[1]).toMatchObject({ synced: 1, started: 1, stops: 0 });
  expect(fixture.manager.stickers).toBeDefined();

  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  expect(fixture.stickers[1]?.stops).toBe(1);
  expect(fixture.manager.stickers).toBeUndefined();
});
