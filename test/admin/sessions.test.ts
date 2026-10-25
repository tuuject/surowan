/**
 * Admin session control: cancel all ongoing work, and abort a running
 * invocation without re-queuing its attached batch.
 */
import { expect, test } from 'vitest';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { attachBucketToInvocation } from '../../src/orchestration/invocation-queue/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { sleep } from '../helpers.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie, textUpdate } from './fixtures.ts';

test('admin can cancel all ongoing sessions', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const received = new Date('2026-03-01T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'backlogged'), received);
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const canceled = await server.handle(post('/api/cancel-ongoing-sessions', {}, cookie));
    expect(canceled.status).toBe(200);
    const body = await readJson(canceled);
    expect(body).toMatchObject({ canceled_buckets: 1, canceled_invocations: 1 });

    const bucketState = store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state;
    expect(bucketState).toBe('expired');
    const invocationState = store.db
      .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
      .get(invocationId)?.state;
    expect(invocationState).toBe('aborted');

    const overview = await readJson(await server.handle(request('/api/overview', { headers })));
    expect(overview.invocation_states).toContainEqual({ label: 'aborted', count: 1 });
  } finally {
    store.close();
  }
});

test('cancel ongoing aborts a running invocation without re-queuing its attached batch', async () => {
  const { store, configStore } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BucketScheduler(store, configStore, async (_id, _snapshot, signal) => {
    await gate;
    return signal.aborted ? { state: 'aborted', reason: 'aborted' } : { state: 'completed', reason: 'done' };
  });
  const server = new AdminServer({ store, configStore, scheduler });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const invocationStates = (): string[] =>
    store.db
      .prepare<[], { state: string }>('SELECT state FROM invocations ORDER BY id')
      .all()
      .map((row) => row.state);
  const until = async (check: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) {
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    const start = new Date();
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    store.db.prepare('UPDATE buckets SET deadline_at = ?').run(new Date(start.getTime() - 1_000).toISOString());
    scheduler.start();
    await until(() => invocationStates()[0] === 'running', 'the running invocation');

    // A second batch attached mid-run and not yet injected.
    ingestion.ingest(textUpdate(2, 11, 'second'), new Date());
    const running = store.db
      .prepare<[], { id: bigint; conversation_id: bigint }>(
        "SELECT id, conversation_id FROM invocations WHERE state = 'running'",
      )
      .get()!;
    const attached = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM buckets WHERE state = 'collecting'")
      .get()!.id;
    attachBucketToInvocation(store, 20, running.id, attached, running.conversation_id, new Date());

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const canceled = await server.handle(post('/api/cancel-ongoing-sessions', {}, cookie));
    expect(canceled.status).toBe(200);
    expect(await readJson(canceled)).toMatchObject({ canceled_buckets: 1, canceled_invocations: 1 });

    release();
    await until(() => invocationStates()[0] === 'aborted', 'the aborted invocation');
    expect(invocationStates()).toEqual(['aborted']);
    const bucketStates = store.db
      .prepare<[], { id: bigint; state: string }>('SELECT id, state FROM buckets ORDER BY id')
      .all()
      .map((row) => [row.id === attached ? 'attached' : 'opening', row.state]);
    expect(bucketStates).toEqual([
      ['opening', 'aborted'],
      ['attached', 'expired'],
    ]);
  } finally {
    release();
    await scheduler.stop();
    store.close();
  }
});
