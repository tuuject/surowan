import { getCurrentTools, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { afterEach, expect, test } from 'vitest';
import { cancelOngoingSessions } from '../src/ingress/admin/operations.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import type { LongTaskService } from '../src/store/long-tasks.ts';
import {
  checkpoints,
  cleanupFixtures,
  complete,
  fixture,
  finished,
  receipts,
  update,
} from './task-hot-injection-fixtures.ts';

afterEach(cleanupFixtures);

test.each(['pause', 'admin_cancel'] as const)(
  '%s prevents attached unconsumed receipts from resurfacing',
  async (action) => {
    const f = await fixture((config) => {
      config.telegram.admins = [42];
    });
    const commands = new BotCommandService(f.store, f.configStore, f.scheduler);
    let attached!: () => void;
    const attachedSignal = new Promise<void>((resolve) => {
      attached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.faux.setResponses([
      async () => {
        complete(f, 'Alice');
        f.scheduler.processTasksDue();
        attached();
        await gate;
        return fauxAssistantMessage('stopped');
      },
    ]);
    f.scheduler.start();
    await attachedSignal;
    expect(receipts(f.store)[0]?.state).toBe('claimed');
    expect(checkpoints(f.store)).toHaveLength(1);
    try {
      if (action === 'pause') {
        expect(await commands.run({ name: 'pause' }, 123456789n, { id: 42n, name: 'Alice', username: null })).toContain(
          '/resume',
        );
      } else {
        cancelOngoingSessions(f.store.orm);
        expect(f.scheduler.abortAll()).toBe(1);
      }
    } finally {
      release();
    }
    await finished(f, 1n);
    expect(f.sends).toEqual([]);
    expect(checkpoints(f.store)).toHaveLength(1);
    expect(f.store.db.prepare('SELECT state, cancel_reason, admin_cancelled FROM task_receipts').all()).toEqual([
      {
        state: 'suppressed',
        cancel_reason: action === 'pause' ? 'chat_paused' : 'admin_cancel',
        admin_cancelled: action === 'admin_cancel' ? 1n : 0n,
      },
    ]);
    expect(f.store.db.prepare('SELECT state FROM buckets WHERE id = ?').get(receipts(f.store)[0]!.bucket_id)).toEqual({
      state: 'expired',
    });
    if (action === 'pause') {
      await commands.run({ name: 'resume' }, 123456789n, { id: 42n, name: 'Alice', username: null });
    }
    expect(f.scheduler.processTasksDue()).toEqual([]);
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  },
);

test.each(['ordinary', 'receipt'] as const)(
  'receipt budget and caller authority do not leak into the next %s round',
  async (next) => {
    let ownedTask: bigint | undefined;
    let taskService: LongTaskService;
    const observations: { caller: bigint | null; ids: bigint[]; cancel: boolean | null }[] = [];
    const f = await fixture(
      (config) => {
        config.agent!.daily_budget!.max_tokens = 10_000_000;
        config.agent!.context!.idle_grace_seconds = next === 'ordinary' ? 1 : 0;
      },
      (context) => [
        {
          name: 'inspect_scope',
          label: 'Inspect scope',
          description: 'Inspect the current task caller in this test.',
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => {
            const scope = taskService.invocationScope('exporter', context);
            ownedTask ??= scope.create({ payload: { private: 'Alice' } }).taskId;
            observations.push({
              caller: context.callerUserId,
              ids: scope.list().map((task) => task.id),
              cancel: context.callerUserId === null ? scope.cancel(ownedTask) : null,
            });
            return { content: [{ type: 'text', text: 'inspected' }], details: {} };
          },
        },
      ],
    );
    taskService = f.tasks;
    const at = new Date().toISOString();
    f.store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', '123456789', 'model_tokens', 9600000, ?)",
      )
      .run(at.slice(0, 10), at);
    const toolSets: string[][] = [];
    const inspect = fauxAssistantMessage(fauxToolCall('inspect_scope', {}), { stopReason: 'toolUse' });
    f.faux.setResponses([
      (context) => {
        toolSets.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return inspect;
      },
      () => {
        complete(f, 'Alice', true);
        f.scheduler.processTasksDue();
        return fauxAssistantMessage('ordinary done');
      },
      (context) => {
        toolSets.push(getCurrentTools(context.messages).map((tool) => tool.name));
        if (next === 'receipt') {
          complete(f, 'Bob', false);
          f.scheduler.processTasksDue();
        } else {
          f.ingestion.ingest(update(2, 'next ordinary request'));
          f.scheduler.processDue();
          f.scheduler.wake();
        }
        return inspect;
      },
      () => {
        expect(checkpoints(f.store)).toHaveLength(2);
        expect(checkpoints(f.store).at(-1)?.text).toContain('Alice-result');
        return fauxAssistantMessage('receipt done');
      },
      (context) => {
        toolSets.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return inspect;
      },
      fauxAssistantMessage('next round done'),
    ]);
    f.scheduler.start();
    await expect.poll(() => observations.length).toBe(3);
    expect(toolSets[0]).toContain('zzz');
    expect(toolSets[1]).not.toContain('zzz');
    expect(toolSets[2]).toContain('zzz');
    expect(observations[0]).toEqual({ caller: 42n, ids: [ownedTask], cancel: null });
    expect(observations[1]).toEqual({ caller: null, ids: [], cancel: false });
    expect(observations[2]).toEqual(
      next === 'ordinary' ? { caller: 42n, ids: [ownedTask], cancel: null } : { caller: null, ids: [], cancel: false },
    );
    await expect.poll(() => receipts(f.store).every((row) => row.state === 'handled'), { timeout: 5_000 }).toBe(true);
    expect(f.tasks.scoped('exporter', 1n).get(ownedTask!)?.state).toBe('waiting');
    expect(checkpoints(f.store)).toHaveLength(3);
    expect(f.store.db.prepare('SELECT id FROM invocations').all()).toEqual([
      { id: receipts(f.store)[0]!.invocation_id },
    ]);
    expect(f.store.db.prepare('SELECT injected_at FROM invocation_buckets').all()).toEqual(
      Array.from({ length: 3 }, () => ({ injected_at: expect.any(String) })),
    );
  },
);
