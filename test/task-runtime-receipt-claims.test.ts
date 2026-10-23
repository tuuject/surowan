import { afterEach, expect, test } from 'vitest';
import { cancelOngoingSessions } from '../src/ingress/admin/operations.ts';
import { InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import { addConversation, cleanupTaskRuntime, insertInvocation, setup, taskState } from './task-runtime-fixtures.ts';

afterEach(cleanupTaskRuntime);

test('active conversations attach multiple independent receipts even mid-round and reassign only unconsumed work', async () => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const injections: { bucketId: bigint; kind: string | undefined }[] = [];
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => true,
      queueInjection: (conversation, bucketId, kind) => {
        expect(conversation).toBe(conversationId);
        injections.push({ bucketId, kind });
      },
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const first = scope.create({ payload: { index: 1 } });
  const second = scope.create({ payload: { index: 2 } });
  scope.complete(first.taskId);
  scope.complete(second.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(injections).toHaveLength(2);
  expect(injections.every((injection) => injection.kind === 'completion')).toBe(true);
  const firstBucket = injections[0]!.bucketId;
  const secondBucket = injections[1]!.bucketId;
  expect(firstBucket).not.toBe(secondBucket);
  expect(tasks.getCompletion(running, firstBucket)?.taskId).toBe(first.taskId);
  expect(tasks.getCompletion(running, secondBucket)?.taskId).toBe(second.taskId);
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM bucket_messages').get()).toEqual({ count: 0n });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  store.db
    .prepare('UPDATE invocation_buckets SET injected_at = ? WHERE bucket_id = ?')
    .run(new Date().toISOString(), firstBucket);
  queue.releaseUninjectedBuckets(running, new Date());
  expect(taskState(store, first.taskId)).toEqual({ state: 'claimed', invocation_id: running });
  const reassigned = taskState(store, second.taskId)!;
  expect(reassigned.state).toBe('claimed');
  expect(reassigned.invocation_id).not.toBe(running);
  expect(tasks.getCompletion(running, secondBucket)).toBeUndefined();
  expect(tasks.getCompletion(reassigned.invocation_id!, secondBucket)?.taskId).toBe(second.taskId);
  // The old scheduler's finally must no longer settle the transferred receipt.
  store.db
    .prepare("UPDATE task_receipts SET state = 'handled' WHERE invocation_id = ? AND state = 'claimed'")
    .run(running);
  expect(taskState(store, second.taskId)?.state).toBe('claimed');
  queue.releaseUninjectedBuckets(running, new Date());
  expect(taskState(store, second.taskId)).toEqual(reassigned);
});

test('closing conversations keep receipts pending until a fresh invocation can wake', async () => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => true,
      isRoundInProgress: () => false,
      queueInjection: () => {
        throw new Error('Closing run must not accept injection');
      },
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: {} });
  scope.complete(created.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(taskState(store, created.taskId)?.state).toBe('pending');
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(running);
  const [next] = queue.processTasksDue();
  expect(next).toBeDefined();
  expect(taskState(store, created.taskId)).toEqual({ state: 'claimed', invocation_id: next });
});

test.each(['admin_cancel', 'chat_paused'])('expired receipt buckets do not resurrect after %s', async (reason) => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: () => {},
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: {} });
  scope.complete(created.taskId);
  queue.processTasksDue();
  store.db
    .prepare(
      "UPDATE buckets SET state = 'expired', error_code = ? WHERE id IN (SELECT bucket_id FROM task_receipts WHERE task_id = ?)",
    )
    .run(reason, created.taskId);
  queue.releaseUninjectedBuckets(running, new Date());
  expect(
    store.db
      .prepare('SELECT state, cancel_reason, admin_cancelled FROM task_receipts WHERE task_id = ?')
      .get(created.taskId),
  ).toEqual({
    state: 'suppressed',
    cancel_reason: reason,
    admin_cancelled: reason === 'admin_cancel' ? 1n : 0n,
  });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  expect(queue.processTasksDue()).toEqual([]);
});

test('admin cancellation preserves completed receipts that have not been claimed yet', async () => {
  const { store, tasks, scheduler, conversationId } = await setup();
  const ordinary = insertInvocation(store, 10n, conversationId, 'queued');
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: { result: 'ready before cancellation' } });
  expect(scope.complete(created.taskId)).toBe(true);
  expect(taskState(store, created.taskId)).toEqual({ state: 'pending', invocation_id: null });

  expect(cancelOngoingSessions(store.orm)).toEqual({ canceled_buckets: 1, canceled_invocations: 1 });
  expect(store.db.prepare('SELECT state, completion_reason FROM invocations WHERE id = ?').get(ordinary)).toEqual({
    state: 'aborted',
    completion_reason: 'admin_cancel',
  });
  expect(
    store.db
      .prepare(
        'SELECT state, invocation_id, bucket_id, cancel_reason, admin_cancelled FROM task_receipts WHERE task_id = ?',
      )
      .get(created.taskId),
  ).toEqual({ state: 'pending', invocation_id: null, bucket_id: null, cancel_reason: null, admin_cancelled: 0n });
  expect(store.db.prepare('SELECT state FROM long_tasks WHERE id = ?').get(created.taskId)).toEqual({
    state: 'completed',
  });

  const [next] = scheduler.processTasksDue();
  expect(next).toBeDefined();
  expect(next).not.toBe(ordinary);
  expect(taskState(store, created.taskId)).toEqual({ state: 'claimed', invocation_id: next });
  expect(
    store.db
      .prepare(
        'SELECT i.state, b.state AS bucket_state FROM invocations i JOIN buckets b ON b.id = i.bucket_id WHERE i.id = ?',
      )
      .get(next!),
  ).toEqual({ state: 'queued', bucket_state: 'queued' });
});

test('a different topic stays pending while same-topic receipts attach', async () => {
  const { store, tasks, configStore } = await setup((config) => {
    config.telegram.chats[0] = { id: 123456789, topic_ids: [10, 20] };
  });
  store.db.prepare('UPDATE conversations SET message_thread_id = 10 WHERE id = 1').run();
  addConversation(store, 1n, 2n, 123456789n, 20n, 'supergroup');
  insertInvocation(store, 10n, 1n, 'running');
  const conversations: bigint[] = [];
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: (conversation) => {
        conversations.push(conversation);
      },
    },
    tasks,
  );
  const other = tasks.scoped('test', 2n).create({ payload: {} });
  tasks.scoped('test', 2n).complete(other.taskId);
  const same = tasks.scoped('test', 1n).create({ payload: {} });
  tasks.scoped('test', 1n).complete(same.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(conversations).toEqual([1n]);
  expect(taskState(store, other.taskId)?.state).toBe('pending');
  expect(taskState(store, same.taskId)).toEqual({ state: 'claimed', invocation_id: 10n });
});
