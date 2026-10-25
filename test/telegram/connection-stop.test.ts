/**
 * The Telegram stop pass.
 *
 * Stopping an instance (a token replacement, an explicit disable or a 401/409)
 * must leave no queued Telegram work behind, must interrupt the running one and
 * must return every delivery receipt that provably never reached Telegram to
 * `pending`, so the reminder is delivered once an instance exists again — but
 * never twice. Rooms are the control group: a Telegram stop never touches
 * their queue.
 */
import { sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { invocations, taskReceipts } from '../../src/store/schema/index.ts';
import {
  bucketState,
  closeConnectionFixtures,
  type ConnectionFixture,
  invocationState,
  openConnectionFixture,
  receiptState,
  seedWork,
} from './connection-fixtures.ts';

afterEach(async () => {
  await closeConnectionFixtures();
});

interface SettledRun {
  readonly state: 'aborted' | 'completed' | 'outcome_unknown';
  readonly sideEffectStarted: boolean;
}

/** Mimics what a run persists when it ends; by default, an abort before any send. */
function settleInterrupted(
  store: ConnectionFixture['store'],
  ids: readonly bigint[],
  run: SettledRun = { state: 'aborted', sideEffectStarted: false },
): void {
  const stamp = new Date().toISOString();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const reason = run.state === 'completed' ? 'completed' : 'telegram_stopped';
  store.orm
    .update(invocations)
    .set({ state: run.state, completionReason: reason, finishedAt: stamp, sideEffectStarted: run.sideEffectStarted })
    .where(sql`id IN (${list})`)
    .run();
  store.orm
    .update(taskReceipts)
    .set({
      state: 'handled',
      handledAt: stamp,
      invocationOutcome: run.state,
      completionReason: reason,
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

test('an interrupted run that never settles is logged and keeps its claim', async () => {
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
  // It may still send, so its delivery is not handed to a second run: the
  // run's own terminal write settles the receipt.
  expect(receiptState(store, seeded.runningReceiptTask)).toMatchObject({
    state: 'claimed',
    invocationId: seeded.runningInvocation,
  });
  // A queued invocation's receipt is requeued immediately, independently of
  // what the running one does.
  expect(receiptState(store, 901n)).toMatchObject({ state: 'pending', invocationId: null });
});

test.each([
  { label: 'finished on its own before the abort landed', run: { state: 'completed', sideEffectStarted: true } },
  { label: 'was aborted after it had started a send', run: { state: 'aborted', sideEffectStarted: true } },
  { label: 'ended with an unknown send outcome', run: { state: 'outcome_unknown', sideEffectStarted: true } },
] as const)('a run that $label keeps its delivered receipt', async ({ run }) => {
  let fixture: ConnectionFixture | undefined;
  fixture = await openConnectionFixture({
    abortInvocations: (ids) => {
      if (fixture !== undefined) {
        settleInterrupted(fixture.store, ids, run);
      }
      return ids.length;
    },
  });
  const { store } = fixture;
  await fixture.manager.start(fixture.hooks);
  const seeded = seedWork(store);

  fixture.manager.applyToken({ kind: 'disabled' });
  await fixture.waitForStatus((state) => state.status === 'disabled');
  await fixture.manager.whenIdle();

  // Re-queueing this receipt would deliver the reminder a second time once an
  // instance is back.
  expect(receiptState(store, seeded.runningReceiptTask)).toMatchObject({
    state: 'handled',
    invocationId: seeded.runningInvocation,
  });
  // The never-started queued run's receipt is still safe to deliver again.
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
