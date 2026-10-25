import { afterEach, expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { addConversation, cleanupTaskRuntime, insertInvocation, setup, stores, taskState } from './runtime-fixtures.ts';

afterEach(cleanupTaskRuntime);

test('a pending receipt survives reopening the store and remains deliverable', async () => {
  const first = await setup();
  const created = first.tasks
    .scoped('external-plugin', first.conversationId)
    .create({ payload: { job: 'after restart' } });
  expect(first.tasks.scoped('external-plugin', first.conversationId).complete(created.taskId)).toBe(true);
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);

  const reopened = await SqliteStore.open(first.loaded.config);
  stores.push(reopened);
  const scheduler = new BucketScheduler(reopened, first.configStore, async () => ({
    state: 'completed',
    reason: 'test',
  }));
  scheduler.recover(new Date());
  expect(taskState(reopened, created.taskId)?.state).toBe('pending');
  expect(scheduler.processTasksDue(new Date())).toHaveLength(1);
  expect(taskState(reopened, created.taskId)?.state).toBe('claimed');
});

test('recovery closes every claimed receipt shape once and aborts queued receipt buckets', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  const variants = ['queued', 'running-clean', 'running-send', 'terminal', 'null'] as const;
  const ids = new Map<(typeof variants)[number], bigint>();
  for (const [index, variant] of variants.entries()) {
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { variant } });
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    ids.set(variant, created.taskId);
    if (variant !== 'null') {
      const invocationId = 100n + BigInt(index);
      const variantConversationId = BigInt(index + 1);
      if (variantConversationId !== conversationId) {
        addConversation(store, BigInt(index + 1), variantConversationId, 123456789n + BigInt(index), 0n);
      }
      const state = variant === 'terminal' ? 'completed' : variant === 'queued' ? 'queued' : 'running';
      insertInvocation(store, invocationId, variantConversationId, state);
      store.db
        .prepare(
          "UPDATE task_receipts SET state = 'claimed', invocation_id = ?, claimed_at = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(invocationId, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', created.taskId);
      if (variant === 'queued') {
        const attached = 200n;
        const at = '2026-01-02T00:00:00.000Z';
        store.db
          .prepare(
            "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, 'queued', 'realtime', ?, ?, ?, ?)",
          )
          .run(attached, variantConversationId, at, at, at, at);
        store.db
          .prepare('INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at) VALUES (?, ?, ?)')
          .run(invocationId, attached, at);
      }
      if (variant === 'running-send') {
        store.db.prepare('UPDATE invocations SET side_effect_started = 1 WHERE id = ?').run(invocationId);
        store.db
          .prepare(
            "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at) VALUES (1, ?, 'send-call', 'send', '{}', 'pending', 1, ?)",
          )
          .run(invocationId, '2026-01-02T00:00:00.000Z');
        store.db
          .prepare(
            "INSERT INTO host_sends(tool_call_id, conversation_id, kind, request_json, state, created_at) VALUES (1, ?, 'text', '{}', 'pending', ?)",
          )
          .run(conversationId, '2026-01-02T00:00:00.000Z');
      }
    } else {
      store.db
        .prepare("UPDATE task_receipts SET state = 'claimed', claimed_at = ?, updated_at = ? WHERE task_id = ?")
        .run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', created.taskId);
    }
  }

  const recoveredAt = new Date('2026-01-03T00:00:00.000Z');
  scheduler.recover(recoveredAt);
  for (const taskId of ids.values()) {
    expect(
      store.db
        .prepare<
          [bigint],
          {
            state: string;
            invocation_outcome: string | null;
            completion_reason: string | null;
            handled_at: string | null;
            updated_at: string;
          }
        >(
          'SELECT state, invocation_outcome, completion_reason, handled_at, updated_at FROM task_receipts WHERE task_id = ?',
        )
        .get(taskId),
    ).toEqual({
      state: 'handled',
      invocation_outcome: 'outcome_unknown',
      completion_reason: 'outcome_unknown',
      handled_at: recoveredAt.toISOString(),
      updated_at: recoveredAt.toISOString(),
    });
  }
  expect(store.db.prepare('SELECT state, completion_reason FROM invocations WHERE id = 100').get()).toEqual({
    state: 'aborted',
    completion_reason: 'process_restart',
  });
  expect(
    store.db.prepare('SELECT id, state, error_code FROM buckets WHERE id IN (100, 200) ORDER BY id').all(),
  ).toEqual([
    { id: 100n, state: 'aborted', error_code: 'process_restart' },
    { id: 200n, state: 'aborted', error_code: 'process_restart' },
  ]);
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 101').get()).toEqual({ state: 'aborted' });
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 102').get()).toEqual({ state: 'outcome_unknown' });
  expect(store.db.prepare('SELECT state FROM host_sends WHERE tool_call_id = 1').get()).toEqual({
    state: 'pending',
  });
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 103').get()).toEqual({ state: 'completed' });

  const before = store.db.prepare('SELECT task_id, handled_at, updated_at FROM task_receipts ORDER BY task_id').all();
  scheduler.recover(new Date('2026-01-04T00:00:00.000Z'));
  expect(store.db.prepare('SELECT task_id, handled_at, updated_at FROM task_receipts ORDER BY task_id').all()).toEqual(
    before,
  );
});
