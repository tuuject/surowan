import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GenerationInput } from '../src/contracts.ts';
import { generationCreateSchema } from '../src/contracts.ts';
import { createTestCore, defaultModel, fakeProvider, parseInput, pngBytes, publishDefaultConfig } from './helpers.ts';

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

    // Inline image references become their ordered label in place: B appears
    // first (图 1), A second (图 2), and the repeated B keeps its first label.
    assert.equal(snapshot.resolvedPrompt, '水彩画风，柔和| 短发女孩| 图 1 中间文字 图 2 再次 图 1 结束');
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

test('ordinal labels keep their digits separate from adjacent digits', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
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
    const snapshot = run.core.generations.resolve(
      parseInput({
        authoredPrompt: `v2{{image:${imageA.id}}}3 und 4{{image:${imageB.id}}}5`,
        modelId: 'gpt-image-1',
      }),
    );
    // The label stays delimited on both sides, so slot 1 is never read as 13.
    assert.equal(snapshot.finalPrompt, 'v2 图 1 3 und 4 图 2 5');
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

test('an image-only prompt resolves to its label; blank text still fails', async () => {
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
    // The reference is text now: a prompt that only references one image is a
    // one-label prompt, not an empty one.
    const snapshot = run.core.generations.resolve(
      generationCreateSchema.parse({
        authoredPrompt: `{{image:${image.id}}}`,
        modelId: 'gpt-image-1',
        outputCount: 1,
      }),
    );
    assert.equal(snapshot.finalPrompt, '图 1');

    assert.throws(
      () =>
        run.core.generations.resolve(
          generationCreateSchema.parse({
            authoredPrompt: '   ',
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

test('explicit inputs keep their ordered position without appearing in the text', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    // Three input images need a model that accepts three.
    publishDefaultConfig(run.config, [
      defaultModel({ capabilities: { ...defaultModel().capabilities, maxInputImages: 4 } }),
    ]);
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

    // The PRD example: inline references label in place by first appearance.
    const pdp = run.core.generations.resolve(
      parseInput({
        authoredPrompt: `画一个我的自设，这是我的三视图：{{image:${imageA.id}}}，背景参考这张：{{image:${imageB.id}}}`,
        modelId: 'gpt-image-1',
      }),
    );
    assert.equal(pdp.finalPrompt, `画一个我的自设，这是我的三视图：图 1，背景参考这张：图 2`);

    // Explicit inputs join the ordered list after the inline ones: A and C are
    // inline (图 1, 图 2), B is explicit-only and keeps position 3 silently.
    const snapshot = run.core.generations.resolve(
      parseInput({
        authoredPrompt: `前面 {{image:${imageA.id}}} 后面 {{image:${imageC.id}}}`,
        modelId: 'gpt-image-1',
        inputImages: [imageB.id, imageC.id],
      }),
    );
    assert.equal(snapshot.finalPrompt, '前面 图 1 后面 图 2');
    assert.deepEqual(
      snapshot.imageAssets.map((asset) => asset.id),
      [imageA.id, imageC.id, imageB.id],
    );
  } finally {
    await run.cleanup();
  }
});
