import { afterAll, expect, test } from 'vitest';
import { standingWarnings } from '../src/platform/warning-catalog.ts';
import { invocations } from '../src/store/schema.ts';
import { WarningService, serializeVariables } from '../src/store/warnings.ts';
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

test('the invocation failure-rate warning samples the latest 100 completed or failed runs', async () => {
  const { store } = await openStore();
  try {
    const seed = seedAdminFixture(store);
    const finishedAt = FIXED_NOW.toISOString();
    for (let index = 0; index < 100; index += 1) {
      store.orm
        .insert(invocations)
        .values({
          bucketId: seed.bucketA,
          conversationId: seed.conversationId,
          state: index < 51 ? 'failed' : 'completed',
          configHash: 'warning-test',
          promptVersion: 1n,
          startedAt: finishedAt,
          finishedAt,
          createdAt: finishedAt,
        })
        .run();
    }
    const warnings = new WarningService(store.orm);
    warnings.observeInvocation(FIXED_NOW);
    const items = warnings.list({ limit: 10 }).items;
    const failureRate = items.find((item) => item.code === 'invocation_failure_rate');
    expect(failureRate).toMatchObject({
      code: 'invocation_failure_rate',
      variables: expect.objectContaining({
        failed: 51,
        total: 100,
        failure_rate: 0.51,
        threshold: 0.5,
        last_failed_at: finishedAt,
      }),
    });
  } finally {
    store.close();
  }
});

test('a small sample still raises the failure-rate warning when it exceeds the threshold', async () => {
  const { store } = await openStore();
  try {
    const seed = seedAdminFixture(store);
    const finishedAt = FIXED_NOW.toISOString();
    // The shared fixture already has one completed and one failed invocation;
    // two more failures make the sample 3/4, over the 50% threshold.
    for (let index = 0; index < 2; index += 1) {
      store.orm
        .insert(invocations)
        .values({
          bucketId: seed.bucketA,
          conversationId: seed.conversationId,
          state: 'failed',
          configHash: 'warning-test',
          promptVersion: 1n,
          startedAt: finishedAt,
          finishedAt,
          createdAt: finishedAt,
        })
        .run();
    }
    const warnings = new WarningService(store.orm);
    warnings.observeInvocation(FIXED_NOW);
    expect(warnings.list({ limit: 10 }).items.find((item) => item.code === 'invocation_failure_rate')).toMatchObject({
      code: 'invocation_failure_rate',
      variables: expect.objectContaining({ failed: 3, total: 4, failure_rate: 0.75 }),
    });
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
