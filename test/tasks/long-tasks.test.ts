import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { definePlugin, type InvocationScope, loadPlugins } from '../../src/plugins/plugin.ts';
import { LongTaskService, TaskQuotaError } from '../../src/store/long-tasks/index.ts';
import { longTasks, taskReceipts } from '../../src/store/schema/index.ts';
import { cleanupTestDirectories, ctx, directories, initDb, seedInvocation } from './fixtures.ts';

afterEach(cleanupTestDirectories);

describe('LongTaskService', () => {
  test('loadPlugins binds task service without a sidecar context writer', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    let captured: InvocationScope | undefined;
    const loaded = loadPlugins([
      definePlugin({
        hosts: ['telegram'],
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

  test('creates a null-owned task but does not expose it through user scope', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { callerUserId: null }), ['telegram']);
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
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { invocationId: invId }), ['telegram']);
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
    const a = tasks.invocationScope('plugin-a', ctx(conversationId, { invocationId: invId }), ['telegram']);
    const b = tasks.invocationScope('plugin-b', ctx(conversationId, { invocationId: invId }), ['telegram']);
    a.create({ payload: 1, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    const created = b.create({ payload: 2, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    expect(typeof created.taskId).toBe('bigint');
  });

  test('invocationScope list filters by caller', async () => {
    const { store, conversationId } = await initDb();
    const invId = 500n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope42 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 42n }), [
      'telegram',
    ]);
    scope42.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const scope99 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 99n }), [
      'telegram',
    ]);
    scope99.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope42.list()).toHaveLength(1);
    expect(scope99.list()).toHaveLength(1);
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
    const ownerScope = tasks.invocationScope('alarm', live, ['telegram']);
    const created = ownerScope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(true);

    caller = 99n;
    expect(ownerScope.cancel(created.taskId)).toBe(false);
    expect(tasks.invocationScope('other-plugin', ctx(conversationId), ['telegram']).cancel(created.taskId)).toBe(false);
    store.db
      .prepare(
        `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
         VALUES (202, 1, 5, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(tasks.invocationScope('alarm', ctx(202n), ['telegram']).cancel(created.taskId)).toBe(false);

    caller = 42n;
    expect(ownerScope.cancel(created.taskId)).toBe(true);
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.state).toBe('suppressed');
  });

  test('JSON payload rejects non-JSON structures without invoking accessors', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId), ['telegram']);
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
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId), ['telegram']);
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
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId), ['telegram']);
    expect(() => scope.create({ payload: '猫'.repeat(6_000), delivery: { bypassDailyBudget: false } })).toThrow(
      'exceeds',
    );

    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(() =>
      tasks.scoped('test-plugin', conversationId).complete(created.taskId, { big: 'x'.repeat(17_000) }),
    ).toThrow('exceeds');
  });
});
