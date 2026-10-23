import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GenerationInput } from '../src/contracts.ts';
import { generationCreateSchema } from '../src/contracts.ts';
import { createTestCore, fakeProvider, parseInput, pngBytes, publishDefaultConfig } from './helpers.ts';

test('resolve expands prompt references in place and orders images by first appearance', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const style = run.core.prompts.create({ name: '风格', body: '水彩画风，柔和', description: '', category: '' });
    const hero = run.core.prompts.create({ name: '主角', body: '短发女孩', description: '', category: '' });
    const imageA = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes({ width: 5, height: 5 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageB = await run.core.images.create({
      name: 'B',
      base64: (await pngBytes({ width: 6, height: 6 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const authored = `{{prompt:${style.id}}}| {{prompt:${hero.id}}}| {{image:${imageB.id}}} 中间文字 {{image:${imageA.id}}} 再次 {{image:${imageB.id}}} 结束`;
    const snapshot = run.core.generations.resolve(
      parseInput({
        authoredPrompt: authored,
        modelId: 'gpt-image-1',
        aspectRatio: '1:1',
        resolution: 'high',
        outputCount: 2,
      }),
    );

    assert.equal(snapshot.resolvedPrompt, '水彩画风，柔和| 短发女孩|  中间文字  再次  结束');
    assert.equal(snapshot.finalPrompt, snapshot.resolvedPrompt);
    assert.deepEqual(
      snapshot.promptAssets.map((asset) => asset.name),
      ['风格', '主角'],
    );
    assert.deepEqual(
      snapshot.imageAssets.map((asset) => asset.id),
      [imageB.id, imageA.id],
    );
    assert.equal(snapshot.authored.aspectRatio, '1:1');
    assert.equal(snapshot.authored.resolution, 'high');
    assert.equal(snapshot.authored.extendedData, undefined);
    assert.deepEqual(snapshot.requestSemantics, {
      adapterVersion: 2,
      calls: 2,
      imagesPerCall: 1,
      appendedInstructions: [],
    });
    assert.equal(snapshot.configVersion.length, 32);
    assert.equal(provider.calls.length, 0, 'resolve 不产生上游调用');
  } finally {
    await run.cleanup();
  }
});

test('resolve rejects dangling, malformed, empty and over-limit inputs', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const missing = '00000000-0000-4000-8000-000000000000';
    const cases: [GenerationInput, string][] = [
      [parseInput({ authoredPrompt: `只有图片 {{image:${missing}}}`, modelId: 'gpt-image-1' }), 'missing_reference'],
      [parseInput({ authoredPrompt: '损坏 {{prompt:not-a-uuid}}', modelId: 'gpt-image-1' }), 'malformed_reference'],
      [parseInput({ authoredPrompt: '坏括号 {{ 结尾', modelId: 'gpt-image-1' }), 'malformed_reference'],
    ];
    for (const [input, code] of cases) {
      assert.throws(
        () => run.core.generations.resolve(input),
        (error: { code?: string }) => error.code === code,
        JSON.stringify(input),
      );
    }

    // Unknown model and unsupported capability.
    assert.throws(
      () => run.core.generations.resolve(generationCreateSchema.parse({ authoredPrompt: 'hi', modelId: 'nope' })),
      (error: { code?: string }) => error.code === 'unknown_model',
    );
    assert.throws(
      () =>
        run.core.generations.resolve(
          generationCreateSchema.parse({ authoredPrompt: 'hi', modelId: 'gpt-image-1', aspectRatio: '16:9' }),
        ),
      (error: { code?: string }) => error.code === 'unsupported_capability',
    );

    // More references than the model allows (maxReferences: 2).
    const imageA = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageB = await run.core.images.create({
      name: 'B',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageC = await run.core.images.create({
      name: 'C',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    assert.throws(
      () =>
        run.core.generations.resolve(
          generationCreateSchema.parse({
            authoredPrompt: `{{image:${imageA.id}}} {{image:${imageB.id}}} {{image:${imageC.id}}}`,
            modelId: 'gpt-image-1',
            outputCount: 1,
          }),
        ),
      (error: { code?: string }) => error.code === 'too_many_input_images',
    );
    assert.equal(provider.calls.length, 0);
  } finally {
    await run.cleanup();
  }
});

test('resolve reports empty prompts after removing image tokens', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const image = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    assert.throws(
      () =>
        run.core.generations.resolve(
          generationCreateSchema.parse({
            authoredPrompt: `{{image:${image.id}}}`,
            modelId: 'gpt-image-1',
            outputCount: 1,
          }),
        ),
      (error: { code?: string }) => error.code === 'empty_prompt',
    );
  } finally {
    await run.cleanup();
  }
});
