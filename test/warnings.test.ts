import { afterAll, expect, test } from 'vitest';
import { standingWarnings } from '../src/platform/warning-catalog.ts';
import { invocations } from '../src/store/schema.ts';
import { INVOCATION_FAILURE_FLOOR_KEY, WarningService, serializeVariables } from '../src/store/warnings.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { cleanupSchemaDirectories, openStore } from './schema-fixtures.ts';

afterAll(cleanupSchemaDirectories);

const FIXED_NOW = new Date('2026-10-23T12:00:00.000Z');

test('unread warnings of the same code are updated instead of duplicated', async () => {
  const { store } = await openStore();
  try {
    const warnings = new WarningService(store.orm);
    const first = warnings.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5, last_failed_at: FIXED_NOW.toISOString() },
      now: FIXED_NOW,
    });
    const second = warnings.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 6, threshold: 5, last_failed_at: FIXED_NOW.toISOString() },
      now: new Date(FIXED_NOW.getTime() + 1_000),
    });
    expect(second.id).toBe(first.id);
    expect(warnings.unreadCount()).toBe(1);
    expect(warnings.list({ limit: 10 }).items).toEqual([
      expect.objectContaining({
        id: first.id,
        code: 'admin_login_failures',
        variables: expect.objectContaining({ consecutive_failures: 6 }),
        read_at: null,
      }),
    ]);

    const read = warnings.markRead(first.id, FIXED_NOW);
    expect(read?.read_at).toBe(FIXED_NOW.toISOString());
    expect(warnings.unreadCount()).toBe(0);
    expect(warnings.markRead(first.id)?.id).toBe(first.id);
    expect(warnings.markRead(999n)).toBeNull();

    const third = warnings.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5, last_failed_at: FIXED_NOW.toISOString() },
      now: FIXED_NOW,
    });
    expect(third.id).not.toBe(first.id);
    expect(warnings.list({ limit: 10 }).items).toHaveLength(2);
    expect(warnings.clear()).toBe(2);
    expect(warnings.unreadCount()).toBe(0);

    // A stale tab still holding `third.id` must not be able to mark a new warning read.
    const afterClear = warnings.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5, last_failed_at: FIXED_NOW.toISOString() },
      now: FIXED_NOW,
    });
    expect(afterClear.id).toBeGreaterThan(third.id);
    expect(warnings.markRead(third.id)).toBeNull();
    expect(warnings.unreadCount()).toBe(1);
  } finally {
    store.close();
  }
});

test('only read warnings older than the retention window are purged', async () => {
  const { store } = await openStore();
  try {
    const warnings = new WarningService(store.orm);
    const old = warnings.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5, last_failed_at: FIXED_NOW.toISOString() },
      now: FIXED_NOW,
    });
    const recent = warnings.record({
      code: 'invocation_failure_rate',
      variables: { failed: 51, total: 100, failure_rate: 0.51, threshold: 0.5, sample_size: 100 },
      now: FIXED_NOW,
    });
    warnings.markRead(old.id, new Date(FIXED_NOW.getTime() - 40 * 86_400_000));
    warnings.markRead(recent.id, new Date(FIXED_NOW.getTime() - 10 * 86_400_000));
    expect(warnings.purgeReadOlderThan(30, FIXED_NOW)).toBe(1);
    expect(warnings.list({ limit: 10 }).items.map((item) => item.id)).toEqual([recent.id]);
  } finally {
    store.close();
  }
});

test('warning variables must be bounded plain JSON', () => {
  expect(serializeVariables({ count: 3, nested: { ok: true, values: ['a', null] } })).toBe(
    '{"count":3,"nested":{"ok":true,"values":["a",null]}}',
  );
  expect(() => serializeVariables({ callback: () => undefined })).toThrow(/JSON values/);
  expect(() => serializeVariables({ value: Number.NaN })).toThrow(/finite/);
  expect(() => serializeVariables({ when: new Date() })).toThrow(/plain JSON objects/);
  expect(() => serializeVariables({ large: 'x'.repeat(9_000) })).toThrow(/8192 bytes/);
});

test('standing warnings follow the active configuration and keep no history', async () => {
  const { store, loaded } = await openStore();
  try {
    const base = loaded.config;
    expect(standingWarnings(base, FIXED_NOW)).toEqual([]);

    const recording = standingWarnings(
      { ...base, developer: { ...base.developer, record_model_payloads: true } },
      FIXED_NOW,
    );
    expect(recording).toEqual([
      expect.objectContaining({ kind: 'standing', code: 'developer_payload_recording', severity: 'warning' }),
    ]);

    const { provider: _agentProvider, ...agent } = base.agent;
    const missingAgent = standingWarnings({ ...base, agent }, FIXED_NOW);
    expect(missingAgent).toEqual([
      expect.objectContaining({
        code: 'agent_model_missing',
        variables: { missing_fields: ['provider'] },
      }),
    ]);

    const { model: _visionModel, ...vision } = base.vision;
    const missingVision = standingWarnings({ ...base, vision }, FIXED_NOW);
    expect(missingVision).toEqual([
      expect.objectContaining({
        code: 'vision_model_missing',
        variables: { missing_fields: ['model'] },
      }),
    ]);
  } finally {
    store.close();
  }
});

test('the invocation failure-rate warning samples the latest 40 completed or failed runs', async () => {
  const { store } = await openStore();
  try {
    const seed = seedAdminFixture(store);
    // Older successes fall outside the window; inside it 21 of 40 failed.
    insertInvocations(store, seed, [
      ...Array.from({ length: 30 }, () => 'completed' as const),
      ...Array.from({ length: 21 }, () => 'failed' as const),
      ...Array.from({ length: 19 }, () => 'completed' as const),
    ]);
    const warnings = new WarningService(store.orm);
    warnings.observeInvocation(FIXED_NOW);
    const items = warnings.list({ limit: 10 }).items;
    const failureRate = items.find((item) => item.code === 'invocation_failure_rate');
    expect(failureRate).toMatchObject({
      code: 'invocation_failure_rate',
      variables: expect.objectContaining({
        failed: 21,
        total: 40,
        failure_rate: 0.525,
        threshold: 0.5,
        sample_size: 40,
        last_failed_at: FIXED_NOW.toISOString(),
      }),
    });
  } finally {
    store.close();
  }
});

function insertInvocations(
  store: Awaited<ReturnType<typeof openStore>>['store'],
  seed: ReturnType<typeof seedAdminFixture>,
  states: readonly ('completed' | 'failed')[],
): void {
  const finishedAt = FIXED_NOW.toISOString();
  for (const state of states) {
    store.orm
      .insert(invocations)
      .values({
        bucketId: seed.bucketA,
        conversationId: seed.conversationId,
        state,
        configHash: 'warning-test',
        promptVersion: 1n,
        startedAt: finishedAt,
        finishedAt,
        createdAt: finishedAt,
      })
      .run();
  }
}

test('the failure-rate warning waits for twenty terminal invocations', async () => {
  const { store } = await openStore();
  try {
    const seed = seedAdminFixture(store);
    const warnings = new WarningService(store.orm);
    // The shared fixture already has one completed and one failed invocation.
    insertInvocations(
      store,
      seed,
      Array.from({ length: 17 }, () => 'failed'),
    );
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.unreadCount()).toBe(0);

    insertInvocations(store, seed, ['failed']);
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.list({ limit: 10 }).items.find((item) => item.code === 'invocation_failure_rate')).toMatchObject({
      variables: expect.objectContaining({ failed: 19, total: 20, failure_rate: 0.95 }),
    });
  } finally {
    store.close();
  }
});

test('reading or clearing the failure-rate warning restarts the sample after the newest invocation', async () => {
  const { store } = await openStore();
  try {
    const seed = seedAdminFixture(store);
    const warnings = new WarningService(store.orm);
    insertInvocations(
      store,
      seed,
      Array.from({ length: 30 }, () => 'failed'),
    );
    warnings.observeInvocation(FIXED_NOW);
    const first = warnings.list({ limit: 10 }).items.find((item) => item.code === 'invocation_failure_rate');
    expect(first).toBeDefined();
    warnings.markRead(first?.id ?? 0n, FIXED_NOW);
    const floor = store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(INVOCATION_FAILURE_FLOOR_KEY) as {
      value: string;
    };
    const newest = store.db.prepare('SELECT max(id) AS id FROM invocations').get() as { id: number | bigint };
    expect(floor.value).toBe(String(newest.id));

    // The acknowledged failures stay behind the floor: one more failure is a
    // sample of 1, not 31 of 32.
    insertInvocations(store, seed, ['failed']);
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.unreadCount()).toBe(0);

    insertInvocations(
      store,
      seed,
      Array.from({ length: 19 }, () => 'failed'),
    );
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.list({ limit: 10, unreadOnly: true }).items).toEqual([
      expect.objectContaining({
        code: 'invocation_failure_rate',
        variables: expect.objectContaining({ failed: 20, total: 20 }),
      }),
    ]);

    // Clearing an unread failure-rate warning acknowledges it the same way.
    warnings.clear(FIXED_NOW);
    insertInvocations(store, seed, ['failed']);
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.unreadCount()).toBe(0);
  } finally {
    store.close();
  }
});

test('login failure counting starts the warning at five and resets on success', async () => {
  const { store } = await openStore();
  try {
    const warnings = new WarningService(store.orm);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      warnings.loginFailed(FIXED_NOW);
    }
    expect(warnings.unreadCount()).toBe(0);
    warnings.loginFailed(FIXED_NOW);
    expect(warnings.list({ limit: 10 }).items[0]).toMatchObject({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5 },
    });

    warnings.markRead(warnings.list({ limit: 10 }).items[0]!.id);
    warnings.loginSucceeded();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      warnings.loginFailed(FIXED_NOW);
    }
    expect(warnings.unreadCount()).toBe(0);
  } finally {
    store.close();
  }
});
