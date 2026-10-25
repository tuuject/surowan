import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { ConversationContextStore } from '../../src/context/store.ts';
import { CHAT_ID, checkpointTexts, fixture, receipt } from './context-fixtures.ts';

test.each([false, true])('daily budget bypass=%s is frozen in task policy, not result data', async (bypass) => {
  const f = await fixture((config) => {
    config.agent!.daily_budget!.max_tokens = 100;
  });
  const at = new Date().toISOString();
  f.store.db
    .prepare(
      "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 100, ?)",
    )
    .run(at.slice(0, 10), String(CHAT_ID), at);
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({ payload: {}, delivery: { bypassDailyBudget: bypass } });
  scope.complete(task.taskId, { bypassDailyBudget: !bypass, delivery: { bypassDailyBudget: !bypass } });
  const tools: string[][] = [];
  f.faux.setResponses([
    (context) => {
      tools.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'budgeted result' }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage(''),
  ]);
  f.scheduler.start();
  await expect.poll(() => receipt(f.store, task.taskId)?.state).toBe('handled');
  expect(receipt(f.store, task.taskId)).toMatchObject(
    bypass
      ? { invocation_outcome: 'completed', completion_reason: 'completed' }
      : { invocation_outcome: 'failed', completion_reason: 'daily_token_budget' },
  );
  expect(f.sends).toEqual(bypass ? ['budgeted result'] : []);
  if (bypass) {
    expect(tools[0]).not.toContain('zzz');
  } else {
    expect(tools).toEqual([]);
  }
  expect(checkpointTexts(f.store)).toHaveLength(1);
});

test('bypass receipts still obey turn and chat send-rate budgets', async () => {
  const f = await fixture((config) => {
    config.agent!.rate_limits!.turns_per_injection = 3;
    config.agent!.rate_limits!.sends_per_window = 1;
  });
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({ payload: {}, delivery: { bypassDailyBudget: true } });
  scope.complete(task.taskId);
  f.faux.setResponses(
    // Distinct texts, so the duplicate send guard does not reject them before the rate limit does.
    Array.from({ length: 5 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: `result ${index + 1}` }), {
        stopReason: 'toolUse',
      }),
    ),
  );
  f.scheduler.start();
  await expect.poll(() => receipt(f.store, task.taskId)?.state).toBe('handled');
  expect(receipt(f.store, task.taskId)).toMatchObject({
    invocation_outcome: 'completed',
    completion_reason: 'turn_budget',
  });
  expect(f.sends).toEqual(['result 1']);
  expect(
    f.store.db
      .prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM tool_calls ORDER BY id')
      .all(),
  ).toEqual([
    { state: 'success', error_code: null },
    { state: 'error', error_code: 'send_rate_limited' },
    { state: 'error', error_code: 'send_rate_limited' },
  ]);
  expect(new ConversationContextStore(f.store).header(1n)?.sendCountTotal).toBe(1n);
});

test('bypass receipts still enter a single send-only closing turn at the context limit', async () => {
  // Faux reports its own estimated usage; make the real tool registry exceed the threshold.
  const f = await fixture((config) => {
    config.agent!.context_stop_ratio = 0.001;
    config.agent!.context!.hard_token_ratio = 0.001;
  });
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({ payload: {}, delivery: { bypassDailyBudget: true } });
  scope.complete(task.taskId);
  const tools: string[][] = [];
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'system:///missing.md' }), { stopReason: 'toolUse' }),
    (context) => {
      tools.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'closing result' }), {
        stopReason: 'toolUse',
      });
    },
  ]);
  f.scheduler.start();
  await expect.poll(() => receipt(f.store, task.taskId)?.state).toBe('handled');
  expect(receipt(f.store, task.taskId)).toMatchObject({
    invocation_outcome: 'completed',
    completion_reason: 'context_limit',
  });
  expect(tools).toEqual([['send', 'send_reply']]);
  expect(f.sends).toEqual(['closing result']);
  expect(new ConversationContextStore(f.store).header(1n)?.sendCountTotal).toBe(1n);
});

test('daily-budget bypass does not bypass wall-clock abort or replay the claimed receipt', async () => {
  const f = await fixture((config) => {
    config.agent!.context!.max_wall_clock_seconds = 1;
  });
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({ payload: {}, delivery: { bypassDailyBudget: true } });
  scope.complete(task.taskId);
  let sawAbort = false;
  f.faux.setResponses([
    async (_context, options) => {
      const signal = options?.signal;
      if (signal === undefined) {
        throw new Error('Runtime must pass its deadline signal');
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });
      sawAbort = true;
      return fauxAssistantMessage('deadline interrupted the model', { stopReason: 'aborted' });
    },
  ]);
  f.scheduler.start();
  await expect.poll(() => receipt(f.store, task.taskId)?.state, { timeout: 5_000 }).toBe('handled');
  expect(sawAbort).toBe(true);
  expect(receipt(f.store, task.taskId)).toMatchObject({ invocation_outcome: 'aborted', completion_reason: 'timeout' });
  expect(f.sends).toEqual([]);
  expect(checkpointTexts(f.store)).toHaveLength(1);
  expect(
    f.store.db.prepare<[], { state: string; error_code: string }>('SELECT state, error_code FROM model_calls').all(),
  ).toEqual([{ state: 'error', error_code: 'model_aborted' }]);
  expect(
    f.store.db
      .prepare<[], { active_invocation_id: bigint | null }>('SELECT active_invocation_id FROM conversation_contexts')
      .get()?.active_invocation_id,
  ).toBeNull();
  expect(f.scheduler.processTasksDue()).toEqual([]);
});
