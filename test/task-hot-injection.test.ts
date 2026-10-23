import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, expect, test } from 'vitest';
import { ConversationContextStore } from '../src/context/context-store.ts';
import {
  checkpoints,
  cleanupFixtures,
  complete,
  fixture,
  finished,
  receipts,
  send,
} from './task-hot-injection-fixtures.ts';

afterEach(cleanupFixtures);

test('two hot receipts wait for the ordinary tool chain, keep independent checkpoints and mentions, and never trip its send barrier', async () => {
  const f = await fixture((config) => {
    config.developer = { record_model_payloads: true };
  });
  const requests: string[] = [];
  f.faux.setResponses([
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      complete(f, 'Alice');
      complete(f, 'Bob');
      f.scheduler.processTasksDue();
      expect(receipts(f.store)).toHaveLength(2);
      expect(new Set(receipts(f.store).map((row) => row.invocation_id)).size).toBe(1);
      expect(checkpoints(f.store)).toHaveLength(1);
      return send('ordinary response');
    },
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      expect(f.sends).toEqual(['ordinary response']);
      expect(checkpoints(f.store)).toHaveLength(1);
      return fauxAssistantMessage('ordinary round ended');
    },
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      expect(checkpoints(f.store)).toHaveLength(2);
      expect(checkpoints(f.store).at(-1)?.text).toContain('Alice-result');
      expect(checkpoints(f.store).at(-1)?.text).not.toContain('Bob-result');
      return send('first result');
    },
    fauxAssistantMessage('first receipt round ended'),
    () => {
      expect(checkpoints(f.store)).toHaveLength(3);
      expect(checkpoints(f.store).at(-1)?.text).toContain('Bob-result');
      expect(checkpoints(f.store).at(-1)?.text).not.toContain('Alice-result');
      return send('second result');
    },
    fauxAssistantMessage('second receipt round ended'),
  ]);
  f.scheduler.start();
  await finished(f, 1n);
  expect(f.sends).toEqual(['ordinary response', '@Alice first result', '@Bob second result']);
  expect(requests[0]).not.toContain('<untrusted_task_receipt>');
  expect(requests[1]).not.toContain('<untrusted_task_receipt>');
  const rows = receipts(f.store);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.bucket_id)).size).toBe(2);
  for (const row of rows) {
    expect(row).toMatchObject({ state: 'handled', invocation_outcome: 'completed', completion_reason: 'completed' });
    expect(f.tasks.getCompletion(row.invocation_id, row.bucket_id)?.taskId).toBe(row.task_id);
  }
  expect(
    f.store.db.prepare('SELECT invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id').all(),
  ).toEqual(
    Array.from({ length: 3 }, () => ({ invocation_id: rows[0]!.invocation_id, injected_at: expect.any(String) })),
  );
  expect(f.store.db.prepare('SELECT state, error_code FROM tool_calls ORDER BY id').all()).toEqual(
    Array.from({ length: 3 }, () => ({ state: 'success', error_code: null })),
  );
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual(
    Array.from({ length: 6 }, () => ({ state: 'success' })),
  );
  expect(
    f.store.db
      .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls WHERE request_json IS NOT NULL')
      .get()?.count,
  ).toBeGreaterThanOrEqual(3n);
  const points = checkpoints(f.store);
  expect(points.filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
  expect(points.filter(({ text }) => text.includes('Bob-result'))).toHaveLength(1);
  const header = new ConversationContextStore(f.store).header(1n)!;
  expect(header.headSeq).toBe(1n);
  expect(header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(f.conversationRuntime.cachedAgent(1n)?.header).toMatchObject({
    headSeq: header.headSeq,
    nextSeq: header.nextSeq,
  });
  expect(
    f.store.db.prepare('SELECT context_id, ref, source_seq, target_conversation_id FROM context_refs').all(),
  ).toEqual([{ context_id: header.id, ref: 'reply:1', source_seq: points[0]!.seq, target_conversation_id: 1n }]);
});

test('a receipt wakes idle grace in the same invocation and completes normally', async () => {
  const f = await fixture((config) => {
    config.agent!.context!.idle_grace_seconds = 1;
  });
  f.faux.setResponses([
    fauxAssistantMessage('ordinary round ended'),
    send('awake result'),
    fauxAssistantMessage('done'),
  ]);
  f.scheduler.start();
  await expect
    .poll(
      () =>
        f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()?.count === 1n &&
        !f.conversationRuntime.isRoundInProgress(1n),
    )
    .toBe(true);
  const invocation = f.store.db.prepare<[], { id: bigint; state: string }>('SELECT id, state FROM invocations').get()!;
  expect(invocation.state).toBe('running');
  complete(f, 'Alice');
  f.scheduler.processTasksDue();
  expect(receipts(f.store)[0]?.invocation_id).toBe(invocation.id);
  await expect.poll(() => f.sends).toEqual(['@Alice awake result']);
  await expect.poll(() => !f.conversationRuntime.isRoundInProgress(1n)).toBe(true);
  expect(checkpoints(f.store)).toHaveLength(2);
  expect(f.store.db.prepare('SELECT id FROM invocations').all()).toEqual([{ id: invocation.id }]);
  expect(f.store.db.prepare('SELECT injected_at FROM invocation_buckets').all()).toEqual([
    { injected_at: expect.any(String) },
    { injected_at: expect.any(String) },
  ]);
  await expect.poll(() => receipts(f.store)[0]?.state, { timeout: 5_000 }).toBe('handled');
  expect(receipts(f.store)[0]).toMatchObject({ invocation_outcome: 'completed', completion_reason: 'completed' });
  expect(f.store.db.prepare('SELECT id, state FROM invocations').all()).toEqual([
    { id: invocation.id, state: 'completed' },
  ]);
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual([
    { state: 'success' },
    { state: 'success' },
    { state: 'success' },
  ]);
});

test('an unconsumed receipt survives a model error and is handled only by a fresh invocation', async () => {
  const f = await fixture();
  let oldInvocation: bigint | undefined;
  f.faux.setResponses([
    () => {
      complete(f, 'Alice');
      f.scheduler.processTasksDue();
      oldInvocation = receipts(f.store)[0]!.invocation_id;
      expect(receipts(f.store)[0]?.state).toBe('claimed');
      expect(checkpoints(f.store)).toHaveLength(1);
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'model failed before the next boundary' });
    },
    () => {
      expect(receipts(f.store)[0]?.invocation_id).not.toBe(oldInvocation);
      expect(receipts(f.store)[0]?.state).toBe('claimed');
      expect(checkpoints(f.store).filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
      return send('recovered result');
    },
    fauxAssistantMessage('done'),
  ]);
  f.scheduler.start();
  await expect.poll(() => receipts(f.store)[0]?.state).toBe('handled');
  await finished(f, 2n);
  expect(receipts(f.store)[0]).toMatchObject({ invocation_outcome: 'completed', completion_reason: 'completed' });
  expect(receipts(f.store)[0]?.invocation_id).not.toBe(oldInvocation);
  expect(f.sends).toEqual(['@Alice recovered result']);
  expect(checkpoints(f.store).filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
  expect(f.store.db.prepare('SELECT state FROM invocations ORDER BY id').all()).toEqual([
    { state: 'failed' },
    { state: 'completed' },
  ]);
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual([
    { state: 'error' },
    { state: 'success' },
    { state: 'success' },
  ]);
  expect(
    f.store.db
      .prepare<[bigint], { count: bigint }>(
        'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ? AND injected_at IS NOT NULL',
      )
      .get(receipts(f.store)[0]!.invocation_id)?.count,
  ).toBe(1n);
});
