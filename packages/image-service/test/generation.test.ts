import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createImageConfigSnapshot } from '../src/config.ts';
import { generationCreateSchema, listSchema } from '../src/contracts.ts';
import { assertIdempotencyKey, fingerprintOf } from '../src/generations.ts';
import {
  adminActor,
  createTestCore,
  defaultModel,
  fakeProvider,
  keyActor,
  parseInput,
  pngBytes,
  publishDefaultConfig,
  waitFor,
} from './helpers.ts';
import { waitForGeneration } from './generation-fixtures.ts';

const baseInput = parseInput({ authoredPrompt: '一只猫', modelId: 'gpt-image-1' });

test('updateConfig(undefined) reverts the config store to the disabled state', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    assert.ok(run.config.hasValidConfig());
    assert.equal(run.config.current().models.length, 1);

    // Removing the image section from the configuration publishes `undefined`:
    // back to the disabled state, and callers fail with config_unavailable.
    run.config.updateConfig(undefined);
    assert.equal(run.config.hasValidConfig(), false);
    // The disabled state fails with the explicit config_invalid code.
    assert.throws(
      () => run.config.current(),
      (error: { code?: string }) => error.code === 'config_invalid',
    );
    assert.throws(
      () =>
        run.core.generations.create(
          generationCreateSchema.parse({ modelId: 'gpt-image-1', authoredPrompt: 'x', outputCount: 1 }),
          adminActor,
          'disabled',
        ),
      (error: { code?: string }) => error.code === 'config_invalid',
    );

    // Re-publishing re-enables generation.
    run.config.updateConfig(
      createImageConfigSnapshot({ version: 'v2', models: [defaultModel()], credentials: { openrouter: 'sk-test' } }),
    );
    assert.ok(run.config.hasValidConfig());
  } finally {
    await run.cleanup();
  }
});

test('idempotency replays the original task and rejects the same key with different input', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const first = run.core.generations.create(baseInput, adminActor, 'same-key');
    const second = run.core.generations.create(baseInput, adminActor, 'same-key');
    assert.equal(second.generation.id, first.generation.id);
    assert.equal(second.replayed, true);

    assert.throws(
      () => run.core.generations.create({ ...baseInput, authoredPrompt: '另一只猫' }, adminActor, 'same-key'),
      (error: { code?: string }) => error.code === 'idempotency_conflict',
    );

    assert.throws(
      () => run.core.generations.create(baseInput, adminActor, assertIdempotencyKey(undefined)),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
    );
    assert.throws(
      () => run.core.generations.create(baseInput, adminActor, assertIdempotencyKey('has space and is invalid')),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
    );

    await waitForGeneration(run, first.generation.id);
    assert.equal(provider.calls.length, 1, '重复提交不产生第二次上游调用');
  } finally {
    await run.cleanup();
  }
});

test('idempotency keys follow the shared safe-character schema on create and retry', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const safeKey = 'A.b_c-1:'.padEnd(128, 'x');
    assert.equal(safeKey.length, 128);
    assert.equal(assertIdempotencyKey(safeKey), safeKey, '安全字符与 128 位上限必须被接受');

    for (const key of ['has space', 'has/slash', 'bang!', 'x'.repeat(129), '']) {
      assert.throws(
        () => {
          assertIdempotencyKey(key);
        },
        `key=${JSON.stringify(key)}`,
      );
    }

    const created = run.core.generations.create(
      parseInput({ modelId: 'gpt-image-1', authoredPrompt: '安全幂等键', outputCount: 1 }),
      adminActor,
      safeKey,
    );
    await waitForGeneration(run, created.generation.id);
    assert.throws(
      () => assertIdempotencyKey('has space'),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
      'retry 与 create 共用同一个幂等键契约',
    );
    assert.equal(provider.calls.length, 1, '被拒绝的幂等键不产生上游调用');
  } finally {
    await run.cleanup();
  }
});

test('retry is rejected while running and replays with the same idempotency key', async () => {
  let gateResolve!: () => void;
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  const provider = fakeProvider({
    respond: async () => {
      await gate;
      return new Response(
        JSON.stringify({ data: [{ b64_json: (await pngBytes()).toString('base64'), media_type: 'image/png' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const created = run.core.generations.create(
      parseInput({ modelId: 'gpt-image-1', authoredPrompt: '慢任务' }),
      adminActor,
      'gating',
    );
    const id = created.generation.id;
    await waitFor(() => (run.core.generations.getRow(id)?.status === 'running' ? true : null));

    assert.throws(
      () => run.core.generations.retry(id, adminActor, 'retry-while-running'),
      (error: { code?: string }) => error.code === 'generation_running',
    );

    gateResolve();
    await waitForGeneration(run, id);

    const retry = run.core.generations.retry(id, adminActor, 'retry-replay');
    const replay = run.core.generations.retry(id, adminActor, 'retry-replay');
    assert.equal(replay.generation.round, retry.generation.round);
    assert.equal(replay.replayed, true);
    const finished = await waitForGeneration(run, id);
    assert.equal(finished.round, 2);
    assert.equal(provider.calls.length, 2, '重放不产生额外调用');
  } finally {
    await run.cleanup();
  }
});

test('list, detail and scoping keep generations readable per actor', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const mine = run.core.generations.create(
      parseInput({ modelId: 'gpt-image-1', authoredPrompt: '管理员的猫' }),
      adminActor,
      'admin-task',
    );
    const theirs = run.core.generations.create(
      parseInput({ modelId: 'gpt-image-1', authoredPrompt: '客户端的猫' }),
      keyActor,
      'agent-task',
    );
    assert.equal(theirs.generation.source, 'http');
    assert.equal(theirs.generation.actorName, 'agent');

    const adminList = run.core.generations.list(listSchema.parse({}), adminActor);
    assert.equal(adminList.total, 2);
    const agentList = run.core.generations.list(listSchema.parse({}), keyActor);
    assert.equal(agentList.total, 1);
    assert.equal(agentList.items[0]?.id, theirs.generation.id);

    assert.throws(
      () => run.core.generations.get(mine.generation.id, keyActor),
      (error: { code?: string }) => error.code === 'not_found',
      '受限 actor 不能看到他人的任务',
    );

    await waitForGeneration(run, theirs.generation.id);
    await waitForGeneration(run, mine.generation.id);
  } finally {
    await run.cleanup();
  }
});

test('fingerprintOf sorts object keys recursively and keeps array order', () => {
  const left = {
    actorId: 'a',
    operation: 'generation:create',
    input: {
      authoredPrompt: 'cat',
      modelId: 'gpt-image-1',
      extendedData: { quality: 'high', background: 'auto' },
      outputCount: 1,
    },
  };
  const right = {
    input: {
      outputCount: 1,
      extendedData: { background: 'auto', quality: 'high' },
      modelId: 'gpt-image-1',
      authoredPrompt: 'cat',
    },
    operation: 'generation:create',
    actorId: 'a',
  };
  assert.equal(fingerprintOf(left), fingerprintOf(right));
  assert.notEqual(
    fingerprintOf({ extendedData: { quality: 'high' } }),
    fingerprintOf({ extendedData: { quality: 'low' } }),
  );
  assert.notEqual(fingerprintOf({ tags: ['a', 'b'] }), fingerprintOf({ tags: ['b', 'a'] }));
  assert.equal(
    fingerprintOf({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }),
    fingerprintOf({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
  );
});
