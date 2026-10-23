import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GenerationInput } from '../src/contracts.ts';
import { generationCreateSchema } from '../src/contracts.ts';
import {
  adminActor,
  createTestCore,
  fakeProvider,
  parseInput,
  pngBytes,
  PROVIDER_KEY,
  publishDefaultConfig,
} from './helpers.ts';
import { waitForGeneration } from './generation-fixtures.ts';

test('create persists a frozen snapshot, calls the image API once per item and stores outputs', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const style = run.core.prompts.create({ name: '风格', body: '水彩画风', description: '', category: '' });
    const reference = await run.core.images.create({
      name: '参考',
      base64: (await pngBytes({ width: 8, height: 9 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const created = run.core.generations.create(
      parseInput({
        authoredPrompt: `{{prompt:${style.id}}} 一只猫 {{image:${reference.id}}}`,
        modelId: 'gpt-image-1',
        resolution: 'high',
        outputCount: 2,
      }),
      adminActor,
      'key-1',
    );
    assert.equal(created.generation.status, 'queued');
    assert.equal(created.generation.source, 'admin');
    assert.equal(created.generation.actorName, 'admin');
    assert.equal(
      created.generation.snapshot.authored.authoredPrompt,
      `{{prompt:${style.id}}} 一只猫 {{image:${reference.id}}}`,
    );
    assert.equal(created.generation.snapshot.resolvedPrompt, '水彩画风 一只猫 ');
    assert.equal(created.generation.snapshot.configVersion, run.core.config.current().version);
    assert.equal(created.generation.snapshot.model.credentialRef, 'openrouter');

    const finished = await waitForGeneration(run, created.generation.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.attempts.length, 2);
    assert.equal(finished.outputs.length, 2);
    assert.equal(provider.calls.length, 2, '每个输出一次调用（n:1）');

    for (const call of provider.calls) {
      assert.equal(call.url, 'https://openrouter.ai/api/v1/images');
      assert.equal(call.headers.authorization, `Bearer ${PROVIDER_KEY}`);
      assert.equal(call.headers['content-type'], 'application/json');
      assert.equal(call.body.model, 'openai/gpt-image-1');
      assert.equal(call.body.n, 1);
      assert.deepEqual(call.body.provider, { only: ['openai'], allow_fallbacks: false });
      assert.equal(call.body.prompt, '水彩画风 一只猫 ');
      assert.equal(call.body.quality, 'high');
      assert.equal(call.body.size, undefined); // authored aspectRatio 'auto' maps to no size
      const references = call.body.input_references as { type: string; image_url: { url: string } }[];
      assert.equal(references.length, 1);
      assert.equal(references[0]?.type, 'image_url');
      assert.equal(
        references[0]?.image_url.url,
        `data:image/png;base64,${(await pngBytes({ width: 8, height: 9 })).toString('base64')}`,
      );
    }

    const output = finished.outputs[0];
    assert.ok(output !== undefined);
    assert.equal(output.source, 'generation');
    assert.equal(output.generationId, finished.id);
    assert.equal(output.outputIndex, 0);
    assert.equal(output.mime, 'image/png');

    const attempt = finished.attempts.find((entry) => entry.itemIndex === 0);
    assert.ok(attempt !== undefined);
    assert.equal(attempt.status, 'succeeded');
    assert.match(String(attempt.providerRequestId), /^req-[12]$/);
    assert.deepEqual(attempt.usage, { total_tokens: 42, cost: 0.01 });
    assert.equal(attempt.outputAssetId, output.id);
    assert.equal(attempt.error, null);

    // The output image is a first-class asset usable as the next reference.
    const next = run.core.generations.resolve(
      parseInput({ authoredPrompt: `再次 {{image:${output.id}}}`, modelId: 'gpt-image-1' }),
    );
    assert.equal(next.imageAssets[0]?.id, output.id);
  } finally {
    await run.cleanup();
  }
});

test('editing or archiving an asset never rewrites accepted snapshots', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const prompt = run.core.prompts.create({ name: '风格', body: '旧正文', description: '', category: '' });
    const image = await run.core.images.create({
      name: '图',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const created = run.core.generations.create(
      parseInput({
        authoredPrompt: `{{prompt:${prompt.id}}} {{image:${image.id}}}`,
        modelId: 'gpt-image-1',
        aspectRatio: '1:1',
        outputCount: 1,
      }),
      adminActor,
      'snapshot-key',
    );
    const id = created.generation.id;
    const firstRound = await waitForGeneration(run, id);

    run.core.prompts.update(prompt.id, { body: '新正文' });
    run.core.images.remove(image.id);

    const generation = run.core.generations.get(id, adminActor);
    assert.equal(generation.snapshot.promptAssets[0]?.body, '旧正文');
    assert.equal(generation.snapshot.resolvedPrompt, '旧正文 ');
    assert.equal(generation.snapshot.imageAssets[0]?.id, image.id);
    assert.equal(provider.calls[0]?.body.prompt, '旧正文 ');

    // New submissions referencing the archived image fail loudly.
    assert.throws(
      () =>
        run.core.generations.create(
          parseInput({ authoredPrompt: `再用 {{image:${image.id}}}`, modelId: 'gpt-image-1', outputCount: 1 }),
          adminActor,
          'archived-ref',
        ),
      (error: { code?: string }) => error.code === 'missing_reference',
    );

    // Retrying the original snapshot still works and uses the frozen input.
    const retry = run.core.generations.retry(id, adminActor, 'retry-1');
    assert.equal(retry.replayed, false);
    const retried = await waitForGeneration(run, id);
    assert.equal(retried.round, 2);
    assert.equal(retried.attempts.length, 2, '重试追加尝试而不是覆盖');
    assert.deepEqual([...new Set(retried.attempts.map((attempt) => attempt.round))].sort(), [1, 2]);
    assert.equal(provider.calls.length, 2, '重试会新增一次上游调用');
    assert.equal(provider.calls[1]?.body.prompt, '旧正文 ');
    assert.ok(!retried.attempts.some((attempt) => attempt.round === 1 && attempt.status !== 'succeeded'));
    assert.equal(firstRound.status, 'succeeded');
  } finally {
    await run.cleanup();
  }
});

test('idempotent replay survives archived references and a removed model', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const prompt = run.core.prompts.create({ name: '风格', body: '旧正文', description: '', category: '' });
    const image = await run.core.images.create({
      name: '参考',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const input: GenerationInput = generationCreateSchema.parse({
      authoredPrompt: `{{prompt:${prompt.id}}} {{image:${image.id}}}`,
      modelId: 'gpt-image-1',
      resolution: 'high',
      outputCount: 1,
    });
    const first = run.core.generations.create(input, adminActor, 'archive-replay');
    const id = first.generation.id;
    const finished = await waitForGeneration(run, id);
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
    const callsAfterFirst = provider.calls.length;

    // Archive both referenced assets and remove the model from the active config.
    run.core.prompts.remove(prompt.id);
    run.core.images.remove(image.id);
    const { createImageConfigSnapshot } = await import('../src/config.ts');
    run.config.updateConfig(createImageConfigSnapshot({ version: 'v2', models: [], credentials: {} }));
    assert.equal(run.core.config.model('gpt-image-1'), null);

    // A fresh request is still resolved against current state and fails loudly.
    assert.throws(
      () => run.core.generations.create(input, adminActor, 'archive-fresh'),
      (error: { code?: string }) => error.code === 'unknown_model',
    );

    // The accepted request replays as-is: same id, original snapshot, no new call.
    const replay = run.core.generations.create(input, adminActor, 'archive-replay');
    assert.equal(replay.generation.id, id);
    assert.equal(replay.generation.snapshot.model.id, 'gpt-image-1');
    assert.equal(replay.generation.snapshot.resolvedPrompt, finished.snapshot.resolvedPrompt);
    assert.equal(provider.calls.length, callsAfterFirst);
  } finally {
    await run.cleanup();
  }
});

test('extendedData key order does not change the create fingerprint', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const payload: GenerationInput = generationCreateSchema.parse({
      authoredPrompt: '一只猫',
      modelId: 'gpt-image-1',
      extendedData: { quality: 'high', background: 'auto' },
      outputCount: 1,
    });
    const first = run.core.generations.create(payload, adminActor, 'parameter-order');
    const finished = await waitForGeneration(run, first.generation.id);
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));

    const reordered = run.core.generations.create(
      generationCreateSchema.parse({
        authoredPrompt: '一只猫',
        modelId: 'gpt-image-1',
        extendedData: { background: 'auto', quality: 'high' },
        outputCount: 1,
      }),
      adminActor,
      'parameter-order',
    );
    assert.equal(reordered.generation.id, first.generation.id, '同一幂等键应重放');
    assert.equal(provider.calls.length, 1, '重放不产生新的上游调用');
  } finally {
    await run.cleanup();
  }
});
