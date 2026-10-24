/**
 * The Telegram stop pass.
 *
 * Stopping an instance (a token replacement, an explicit disable or a 401/409)
 * must leave no queued Telegram work behind, must interrupt the running one and
 * must return every claimed delivery receipt to `pending`, so the reminder is
 * delivered once an instance exists again. Rooms are the control group: a
 * Telegram stop never touches their queue.
 */
import { sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { invocations, taskReceipts } from '../src/store/schema.ts';
import {
  bucketState,
  closeConnectionFixtures,
  type ConnectionFixture,
  invocationState,
  openConnectionFixture,
  receiptState,
  seedWork,
} from './telegram-connection-fixtures.ts';

afterEach(async () => {
  await closeConnectionFixtures();
});

/** Mimics what an interrupted run persists when its abort lands. */
function settleInterrupted(store: ConnectionFixture['store'], ids: readonly bigint[]): void {
  const stamp = new Date().toISOString();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  store.orm
    .update(invocations)
    .set({ state: 'aborted', completionReason: 'telegram_stopped', finishedAt: stamp })
    .where(sql`id IN (${list})`)
    .run();
  store.orm
    .update(taskReceipts)
    .set({
      state: 'handled',
      handledAt: stamp,
      invocationOutcome: 'aborted',
      completionReason: 'telegram_stopped',
      updatedAt: stamp,
    })
    .where(sql`invocation_id IN (${list}) AND state = 'claimed'`)
    .run();
  store.orm.run(sql`UPDATE buckets SET state = 'aborted', finished_at = ${stamp}, updated_at = ${stamp}
    WHERE state = 'running' AND id IN (SELECT bucket_id FROM invocations WHERE id IN (${list}))`);
}

test('a stop expires Telegram work, aborts its invocations and requeues their receipts', async () => {
  let fixture: ConnectionFixture | undefined;
  fixture = await openConnectionFixture({
    withStickers: true,
    abortInvocations: (ids) => {
      if (fixture !== undefined) {
        settleInterrupted(fixture.store, ids);
      }
      return ids.length;
    },
  });
  const { store } = fixture;
  await fixture.manager.start(fixture.hooks);
  expect(fixture.status().status).toBe('connected');
  const seeded = seedWork(store);

  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  await fixture.manager.whenIdle();

  // The instance is gone and the Scheduler gate is closed.
  expect(fixture.holder.current).toBeUndefined();
  expect(fixture.readiness.isReady()).toBe(false);
  expect(fixture.activityStops).toHaveLength(1);
  expect(fixture.stickers[0]?.stops).toBe(1);
  expect(fixture.manager.stickers).toBeUndefined();
  expect(fixture.bots[0]?.stopped).toBe(true);

  // Every queued Telegram batch expires, including the one attached to the
  // running invocation but not injected.
  expect(bucketState(store, seeded.collectingBucket)).toEqual({
    state: 'expired',
    errorCode: 'telegram_stopped',
  });
  expect(bucketState(store, seeded.queuedBucket)).toEqual({ state: 'expired', errorCode: 'telegram_stopped' });
  expect(bucketState(store, seeded.attachedBucket)).toEqual({ state: 'expired', errorCode: 'telegram_stopped' });
  // The interrupted run's own batch closes with the stop reason as well.
  expect(bucketState(store, 902n)).toEqual({ state: 'aborted', errorCode: 'telegram_stopped' });

  expect(invocationState(store, seeded.queuedInvocation)).toEqual({
    state: 'aborted',
    completionReason: 'telegram_stopped',
  });
  expect(invocationState(store, seeded.runningInvocation)).toEqual({
    state: 'aborted',
    completionReason: 'telegram_stopped',
  });
  expect(fixture.aborted).toEqual([{ ids: [seeded.runningInvocation], reason: 'telegram_stopped' }]);

  // Both the queued run's receipt and the interrupted run's receipt are back
  // in the queue, with the link to the aborted invocation cleared.
  for (const taskId of [901n, seeded.runningReceiptTask]) {
    expect(receiptState(store, taskId)).toEqual({
      state: 'pending',
      invocationId: null,
      bucketId: null,
      claimedAt: null,
      handledAt: null,
      cancelReason: null,
    });
  }

  // The control group: a room's queue is none of Telegram's business.
  expect(bucketState(store, seeded.playgroundBucket)).toEqual({ state: 'collecting', errorCode: null });
  expect(invocationState(store, seeded.playgroundInvocation)).toEqual({
    state: 'queued',
    completionReason: null,
  });
  expect(receiptState(store, seeded.playgroundReceiptTask)).toMatchObject({
    state: 'claimed',
    invocationId: seeded.playgroundInvocation,
    bucketId: seeded.playgroundBucket,
  });

  const stopped = fixture.events.find((entry) => entry.event === 'telegram_stopped');
  expect(stopped).toMatchObject({
    reason: 'telegram_stopped',
    expired_buckets: 3,
    aborted_invocations: 1,
    interrupted_invocations: 1,
  });
});

test('an interrupted run that never settles is logged and still returns its receipt', async () => {
  const fixture = await openConnectionFixture({ abortGraceMs: 20 });
  const { store } = fixture;
  await fixture.manager.start(fixture.hooks);
  const seeded = seedWork(store);

  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  await fixture.manager.whenIdle();

  // The run ignores the abort in this fixture; the stop does not wait forever.
  expect(fixture.events.some((entry) => entry.event === 'telegram_invocation_stop_timeout')).toBe(true);
  expect(invocationState(store, seeded.runningInvocation)).toMatchObject({ state: 'running' });
  expect(receiptState(store, seeded.runningReceiptTask)).toMatchObject({
    state: 'pending',
    invocationId: null,
    claimedAt: null,
  });
  // A queued invocation's receipt is requeued immediately, independently of
  // what the running one does.
  expect(receiptState(store, 901n)).toMatchObject({ state: 'pending', invocationId: null });
});

test('replacing a token also stops the old instance work before the new one starts', async () => {
  const fixture = await openConnectionFixture({
    getMe: [
      () => Promise.resolve({ id: 42, first_name: 'First', username: 'first_bot' }),
      () => Promise.resolve({ id: 43, first_name: 'Second', username: 'second_bot' }),
    ],
  });
  const { store } = fixture;
  await fixture.manager.start(fixture.hooks);
  const seeded = seedWork(store);

  fixture.manager.applyToken({ kind: 'token', token: 'replacement-token' });
  await fixture.waitForStatus((state) => state.status === 'connected' && state.bot?.id === '43');
  await fixture.manager.whenIdle();

  expect(fixture.bots[0]?.stopped).toBe(true);
  expect(fixture.bots[1]?.started).toBe(true);
  expect(bucketState(store, seeded.queuedBucket)).toEqual({ state: 'expired', errorCode: 'telegram_stopped' });
  expect(receiptState(store, 901n)).toMatchObject({ state: 'pending', invocationId: null });
  expect(invocationState(store, seeded.queuedInvocation)).toMatchObject({ state: 'aborted' });
  // The replacement's opening batch (the one seeded before it) is unrelated
  // to the old instance's work and stays where it is.
  expect(bucketState(store, seeded.playgroundBucket)).toMatchObject({ state: 'collecting' });
  // A fresh connection is ready again, so queued Telegram work may resume.
  expect(fixture.readiness.isReady()).toBe(true);
});
