import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createImageConfigSnapshot } from '../src/config.ts';
import type { Generation } from '../src/contracts.ts';
import { createImageCore } from '../src/core.ts';
import { ImageStore } from '../src/image-store.ts';
import { createOpenRouterAdapter } from '../src/openrouter.ts';
import { abortable, finished, submit } from './execution-helpers.ts';
import {
  adminActor,
  createTestCore,
  defaultModel,
  fakeProvider,
  openTestDatabase,
  parseInput,
  PROVIDER_KEY,
  publishDefaultConfig,
  waitFor,
} from './helpers.ts';

/** Bounded negative-assertion pause: nothing may happen while the config is invalid. */
const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test('restart resumes queued work and marks running work as interrupted without resending', async () => {
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const storeDir = path.join(tmpdir(), `image-service-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const provider = fakeProvider();
  try {
    // A generation accepted while the worker is stopped stays queued.
    const first = openTestDatabase(file);
    const withoutWorker = createImageCore({
      db: first.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: false,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(withoutWorker.config);
    const queuedId = withoutWorker.generations.create(
      parseInput({ authoredPrompt: '排队任务', modelId: 'gpt-image-1' }),
      adminActor,
      'queued',
    ).generation.id;
    assert.equal(withoutWorker.generations.getRow(queuedId)?.status, 'queued');
    assert.equal(provider.calls.length, 0);
    await withoutWorker.stop();
    first.client.close();

    const resumed = openTestDatabase(file);
    const resumedCore = createImageCore({
      db: resumed.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    // The worker resumes queued work only once a valid config snapshot is published.
    publishDefaultConfig(resumedCore.config);
    const generation = await waitFor(() => {
      const row = resumedCore.generations.getRow(queuedId);
      if (row === null || row.status === 'queued' || row.status === 'running') {
        return null;
      }
      return resumedCore.generations.get(queuedId, adminActor);
    });
    assert.equal(generation.status, 'succeeded');
    assert.equal(provider.calls.length, 1);
    await resumedCore.stop();
    resumed.client.close();

    // Now simulate a crash while a call is in flight, then restart.
    const hanging = fakeProvider({
      respond: async (_call, _index, init) => abortable(init?.signal).promise,
    });
    const running = openTestDatabase(file);
    const runningCore = createImageCore({
      db: running.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: hanging.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(runningCore.config);
    const crashId = runningCore.generations.create(
      parseInput({ authoredPrompt: '崩溃任务', modelId: 'gpt-image-1' }),
      adminActor,
      'crash',
    ).generation.id;
    await waitFor(() => (runningCore.generations.getRow(crashId)?.status === 'running' ? true : null));

    // Hard crash: drop the SQLite handle without a graceful worker shutdown.
    running.client.close();

    const recovered = openTestDatabase(file);
    const recoveredCore = createImageCore({
      db: recovered.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(recoveredCore.config);
    const after = recoveredCore.generations.get(crashId, adminActor);
    assert.equal(after.status, 'interrupted');
    assert.equal(after.attempts[0]?.status, 'interrupted');
    assert.equal(after.attempts[0]?.error?.code, 'server_restart');
    assert.equal(after.attempts[0]?.error?.stage, 'interrupted');
    assert.ok(hanging.calls.length <= 1, '崩溃恢复不重发不确定的调用');
    await recoveredCore.stop();
    recovered.client.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('a restart without a valid config keeps queued work queued until the first publish', async () => {
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const storeDir = path.join(tmpdir(), `image-service-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const provider = fakeProvider();
  try {
    // Accept a generation while the worker is stopped: it stays queued in SQLite.
    const first = openTestDatabase(file);
    const withoutWorker = createImageCore({
      db: first.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: false,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(withoutWorker.config);
    const id = withoutWorker.generations.create(
      parseInput({ authoredPrompt: '配置损坏重启', modelId: 'gpt-image-1' }),
      adminActor,
      'invalid-config-restart',
    ).generation.id;
    assert.equal(withoutWorker.generations.getRow(id)?.status, 'queued');
    await withoutWorker.stop();
    first.client.close();

    // Restart with the worker on but no valid config snapshot. A queued generation
    // must not become an attempt that failed before any provider call.
    const restarted = openTestDatabase(file);
    const restartedCore = createImageCore({
      db: restarted.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    assert.equal(restartedCore.config.hasValidConfig(), false);
    await settle();
    assert.equal(restartedCore.generations.getRow(id)?.status, 'queued');
    assert.equal(restartedCore.generations.attemptsFor(id).length, 0, '无效配置下不产生 attempt');
    assert.equal(provider.calls.length, 0);

    // The first valid publish resumes it exactly once.
    publishDefaultConfig(restartedCore.config);
    const generation = await finishedProxy(restartedCore, id);
    assert.equal(generation.status, 'succeeded');
    assert.equal(generation.attempts.length, 1, '恢复后只执行一次');
    assert.equal(generation.attempts[0]?.status, 'succeeded');
    assert.equal(provider.calls.length, 1, '恢复后恰好一次上游调用');
    await restartedCore.stop();
    restarted.client.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

async function finishedProxy(core: ReturnType<typeof createImageCore>, id: string): Promise<Generation> {
  return waitFor(() => {
    const row = core.generations.getRow(id);
    if (row === null || row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return core.generations.get(id, adminActor);
  });
}

test('a republished config without the original credential fails that task explicitly and keeps the queue moving', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl, startWorker: false });
  try {
    publishDefaultConfig(run.config);
    const firstId = await submit(run, { authoredPrompt: '凭据被删' }, 'credential-gone-1');
    const secondId = await submit(run, { authoredPrompt: '凭据被删 2' }, 'credential-gone-2');

    // A valid config that no longer serves the old model / credential pair.
    const nextModel = defaultModel({
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      upstreamModel: 'openai/gpt-image-2',
      credentialRef: 'openrouter2',
    });
    run.config.updateConfig(
      createImageConfigSnapshot({
        version: 'rev-2',
        models: [nextModel],
        credentials: { openrouter2: PROVIDER_KEY },
      }),
    );

    // Starting the worker drains the queue against the new snapshot: the old
    // model's credential is gone, so both tasks fail explicitly without any
    // provider call, and new submissions against the new model keep working.
    run.core.worker.start();
    for (const id of [firstId, secondId]) {
      const generation = await finished(run, id);
      assert.equal(generation.status, 'failed');
      assert.equal(generation.attempts.length, 1);
      assert.equal(generation.attempts[0]?.error?.code, 'credential_missing');
      assert.equal(generation.attempts[0]?.error?.stage, 'provider');
    }
    assert.equal(provider.calls.length, 0, '凭据缺失不触达上游');

    const nextId = await submit(run, { authoredPrompt: '后续任务', modelId: 'gpt-image-2' }, 'after-credential');
    const next = await finished(run, nextId);
    assert.equal(next.status, 'succeeded');
    assert.equal(provider.calls.length, 1);
  } finally {
    await run.cleanup();
  }
});
