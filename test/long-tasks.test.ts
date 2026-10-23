import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { definePlugin, type InvocationScope, loadPlugins } from '../src/plugins/plugin.ts';
import { LongTaskService, TaskQuotaError } from '../src/store/long-tasks.ts';
import { longTasks, taskReceipts } from '../src/store/schema.ts';
import { cleanupTestDirectories, ctx, directories, initDb, seedInvocation } from './long-tasks-fixtures.ts';

afterEach(cleanupTestDirectories);

describe('LongTaskService', () => {
  test('loadPlugins binds task service without a sidecar context writer', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    let captured: InvocationScope | undefined;
    const loaded = loadPlugins([
      definePlugin({
        id: 'capture',
        capabilities: (scope) => {
          captured = scope;
          return [];
        },
      }),
    ]);
    loaded.capabilities(
      store,
      (await loadConfig(join(directories.at(-1)!, 'config.jsonc'))).config,
      ctx(conversationId),
      Date.now(),
    );
    const created = captured!.tasks.create({ payload: { ok: true } });
    expect(store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get()!.pluginId).toBe('capture');
    expect(captured).not.toHaveProperty('recordHiddenContext');
    expect(store.db.prepare('SELECT id FROM agent_messages').all()).toEqual([]);
  });

  test('creates a waiting task via invocationScope', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({
      payload: { key: 'value' },
      delivery: { bypassDailyBudget: false },
    });
    expect(typeof created.taskId).toBe('bigint');
    const row = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(row).toBeDefined();
    expect(row!.state).toBe('waiting');
    expect(row!.pluginId).toBe('test-plugin');
    expect(row!.createdByUserId).toBe(42n);
    expect(JSON.parse(row!.deliveryJson)).toEqual({ bypassDailyBudget: false });
  });

  test('creates a timer task with scheduled_at', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const scheduled = new Date(Date.now() + 86_400_000).toISOString();
    const created = scope.create({
      payload: { task: 'reminder' },
      delivery: { bypassDailyBudget: true, mentionUser: { userId: 99n, displayName: 'Target' } },
      scheduledAt: scheduled,
    });
    expect(created.scheduledAt).toBe(scheduled);
    const row = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(row!.scheduledAt).toBe(scheduled);
    const delivery = JSON.parse(row!.deliveryJson);
    expect(delivery.bypassDailyBudget).toBe(true);
    expect(delivery.mentionUser.userId).toBe('99');
  });

  test('creates a null-owned task but does not expose it through user scope', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { callerUserId: null }));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope.get(created.taskId)).toBeUndefined();
    expect(scope.list()).toEqual([]);
    expect(scope.cancel(created.taskId)).toBe(false);
  });

  test('enforces maxPerInvocation quota', async () => {
    const { store, conversationId } = await initDb();
    const invId = 300n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { invocationId: invId }));
    scope.create({ payload: { n: 1 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 });
    scope.create({ payload: { n: 2 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 });
    expect(() =>
      scope.create({ payload: { n: 3 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 }),
    ).toThrow(TaskQuotaError);
  });

  test('quota is per plugin, not shared', async () => {
    const { store, conversationId } = await initDb();
    const invId = 301n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const a = tasks.invocationScope('plugin-a', ctx(conversationId, { invocationId: invId }));
    const b = tasks.invocationScope('plugin-b', ctx(conversationId, { invocationId: invId }));
    a.create({ payload: 1, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    const created = b.create({ payload: 2, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    expect(typeof created.taskId).toBe('bigint');
  });

  test("invocationScope list returns caller's waiting tasks", async () => {
    const { store, conversationId } = await initDb();
    const invId = 400n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId }));
    scope.create({ payload: { summary: 'a' }, delivery: { bypassDailyBudget: false } });
    scope.create({ payload: { summary: 'b' }, delivery: { bypassDailyBudget: false } });
    expect(scope.list()).toHaveLength(2);
  });

  test('invocationScope list returns empty for null caller', async () => {
    const { store, conversationId } = await initDb();
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId, { callerUserId: null }));
    expect(scope.list()).toEqual([]);
  });

  test('invocationScope list filters by caller', async () => {
    const { store, conversationId } = await initDb();
    const invId = 500n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope42 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 42n }));
    scope42.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const scope99 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 99n }));
    scope99.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope42.list()).toHaveLength(1);
    expect(scope99.list()).toHaveLength(1);
  });

  test('invocationScope cancel suppresses receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope.cancel(created.taskId)).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('cancelled');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.status).toBe('cancelled');
    expect(receipt!.state).toBe('suppressed');
  });

  test('pending receipt cancellation is isolated by plugin, conversation, and live caller', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    let caller: bigint | null = 42n;
    const live = {
      ...ctx(conversationId),
      get callerUserId() {
        return caller;
      },
    };
    const ownerScope = tasks.invocationScope('alarm', live);
    const created = ownerScope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(true);

    caller = 99n;
    expect(ownerScope.cancel(created.taskId)).toBe(false);
    expect(tasks.invocationScope('other-plugin', ctx(conversationId)).cancel(created.taskId)).toBe(false);
    expect(tasks.invocationScope('alarm', ctx(999n)).cancel(created.taskId)).toBe(false);

    caller = 42n;
    expect(ownerScope.cancel(created.taskId)).toBe(true);
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.state).toBe('suppressed');
  });

  test('JSON payload rejects non-JSON structures without invoking accessors', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId));
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse = Array<unknown>(1);
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    const symbol = { ok: true };
    Object.defineProperty(symbol, Symbol('hidden'), { value: 1, enumerable: true });
    const arrayProperty: unknown[] = [];
    Object.defineProperty(arrayProperty, 'extra', { value: true, enumerable: true });

    for (const payload of [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cycle,
      new Date(),
      sparse,
      getter,
      symbol,
      arrayProperty,
    ]) {
      expect(() => scope.create({ payload, delivery: { bypassDailyBudget: false } })).toThrow();
    }
  });

  test('JSON payload round-trips own __proto__ and constructor keys', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId));
    const payload = JSON.parse('{"nested":{"__proto__":{"polluted":true},"constructor":{"name":"kept"}}}') as unknown;

    const created = scope.create({ payload, delivery: { bypassDailyBudget: false } });
    const restored = scope.get(created.taskId)!.payload as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(restored.nested!, '__proto__')).toBe(true);
    expect(Object.hasOwn(restored.nested!, 'constructor')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(restored.nested!, '__proto__')?.value).toEqual({ polluted: true });
    expect(restored.nested!.constructor).toEqual({ name: 'kept' });
  });

  test('JSON byte limits count UTF-8 bytes', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    expect(() => scope.create({ payload: '猫'.repeat(6_000), delivery: { bypassDailyBudget: false } })).toThrow(
      'exceeds',
    );

    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(() =>
      tasks.scoped('test-plugin', conversationId).complete(created.taskId, { big: 'x'.repeat(17_000) }),
    ).toThrow('exceeds');
  });
});
