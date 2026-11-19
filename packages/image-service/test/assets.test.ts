import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { test } from 'vitest';
import { imageCreateSchema, imageUpdateSchema, listSchema, promptCreateSchema } from '../src/contracts.ts';
import { conflict } from '../src/errors.ts';
import { createTestCore, pngBytes, publishDefaultConfig } from './helpers.ts';

test('prompt assets support CRUD, search and archive semantics', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    publishDefaultConfig(run.config);
    const first = run.core.prompts.create({ name: '角色 小雨', body: '一个爱笑的女孩', description: '', category: '' });
    run.core.prompts.create({ name: '风格 水彩', body: '柔和的水彩质感', description: '', category: '' });

    const page = run.core.prompts.list(listSchema.parse({ q: '水彩' }));
    assert.equal(page.total, 1);
    assert.equal(page.limit, 30);
    assert.equal(page.offset, 0);
    assert.equal(page.items.length, 1);

    const patched = run.core.prompts.update(first.id, { body: '一个爱笑的女孩，短发' });
    assert.equal(patched.body, '一个爱笑的女孩，短发');
    assert.notEqual(patched.updatedAt.length, 0);

    const removed = run.core.prompts.remove(first.id);
    assert.ok(removed.deletedAt !== null);

    assert.equal(run.core.prompts.list(listSchema.parse({})).total, 1);

    // Archived assets stay readable for history, but cannot be edited.
    const detail = run.core.prompts.get(first.id);
    assert.ok(detail !== null && detail.deletedAt !== null);
    assert.throws(
      () => run.core.prompts.update(first.id, { name: '改名' }),
      (error: { code?: string }) => error.code === conflict('asset_archived', '').code,
    );
  } finally {
    await run.cleanup();
  }
});

test('prompt bodies reject reference syntax and unknown fields', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    // The shared contract schema rejects the syntax at the boundary.
    assert.throws(() =>
      promptCreateSchema.parse({ name: 'x', body: '引用 {{prompt:00000000-0000-4000-8000-000000000000}}' }),
    );

    // Core keeps its own guard for anything that bypasses schema validation.
    assert.throws(
      () => run.core.prompts.create({ name: 'x', body: 'broken {{ delimiter', description: '', category: '' }),
      (error: { code?: string }) => error.code === 'recursive_reference',
    );

    assert.throws(() => promptCreateSchema.parse({ name: 'x', body: 'y', nope: 1 }));
  } finally {
    await run.cleanup();
  }
});

test('image assets are verified, immutable and archived instead of deleted', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    const bytes = await pngBytes({ width: 12, height: 7 });
    const uploaded = await run.core.images.create({
      name: '参考图',
      base64: bytes.toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const asset = run.core.images.get(uploaded.id);
    assert.ok(asset !== null, '上传的图片素材应可读取');
    assert.equal(asset.width, 12);
    assert.equal(asset.height, 7);
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.source, 'upload');

    const content = run.core.images.readContent(uploaded.id);
    assert.deepEqual(content.bytes, bytes);

    // Metadata edits never touch the immutable file.
    run.core.images.update(uploaded.id, { name: '改名后的参考图', category: '角色' });
    assert.deepEqual(run.core.images.readContent(uploaded.id).bytes, bytes);

    // Replacing bytes is not part of the contract: the file is immutable and the
    // stored row keeps pointing at it (metadata edits never touch the bytes).
    assert.deepEqual(run.core.images.readContent(uploaded.id).bytes, bytes);

    const removed = run.core.images.remove(uploaded.id);
    assert.ok(removed.deletedAt !== null);
    assert.equal(run.core.images.list(listSchema.parse({})).total, 0);
    assert.deepEqual(run.core.images.readContent(uploaded.id).bytes, bytes);

    const names = readdirSync(run.storeDir);
    assert.equal(names.length, 1, '归档不删除图片文件');
  } finally {
    await run.cleanup();
  }
});

test('image assets carry keywords and an agent-visibility flag, defaulting private', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    const bytes = await pngBytes({ width: 5, height: 5 });
    const uploaded = await run.core.images.create({
      name: '角色 三视图',
      base64: bytes.toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    // Every creation path (upload, generation output, agent input conversion)
    // starts private with no keywords; promotion is an admin-only update.
    assert.equal(uploaded.keywords, '');
    assert.equal(uploaded.agentVisible, false);
    const generationOutput = run.core.images.persist(
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        fileName: 'out.png',
        mime: 'image/png',
        width: 4,
        height: 4,
        bytes: 12,
        sha256: 'x',
      },
      { name: '输出图', description: '', category: '', source: 'generation' },
    );
    assert.equal(generationOutput.keywords, '');
    assert.equal(generationOutput.agentVisible, false);

    // The boundary schema accepts the new fields and keeps rejecting unknowns.
    assert.equal(imageUpdateSchema.safeParse({ keywords: 'tag' }).success, true);
    assert.equal(imageUpdateSchema.safeParse({ agentVisible: true }).success, true);
    assert.equal(imageUpdateSchema.safeParse({ agentVisible: 'yes' }).success, false);
    assert.equal(imageCreateSchema.safeParse({ nope: 1 }).success, false);

    // The update path changes keywords and visibility without touching the file.
    const promoted = run.core.images.update(uploaded.id, {
      keywords: '角色, 三视图, 自设',
      agentVisible: true,
      description: '用户自设的三视图',
      category: '角色',
    });
    assert.equal(promoted.keywords, '角色, 三视图, 自设');
    assert.equal(promoted.agentVisible, true);
    assert.equal(promoted.description, '用户自设的三视图');
    assert.deepEqual(run.core.images.readContent(uploaded.id).bytes, bytes);

    // Archival still refuses edits.
    run.core.images.remove(uploaded.id);
    assert.throws(
      () => run.core.images.update(uploaded.id, { agentVisible: false }),
      (error: { code?: string }) => error.code === conflict('asset_archived', '').code,
    );
  } finally {
    await run.cleanup();
  }
});

test('list search matches keywords; the agent library only returns promoted assets', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    const seed = [
      { name: '花园', keywords: '场景, 植物', visible: true },
      { name: '角色', keywords: '', visible: true },
      { name: '私下草图', keywords: '秘密', visible: false },
    ];
    for (const entry of seed) {
      const created = await run.core.images.create({
        name: entry.name,
        base64: (await pngBytes()).toString('base64'),
        mime: 'image/png',
        description: '',
        category: '',
        source: 'upload',
      });
      run.core.images.update(created.id, { keywords: entry.keywords, agentVisible: entry.visible });
    }

    // The panel list searches all four text fields, keywords included.
    assert.equal(run.core.images.list(listSchema.parse({ q: '植物' })).total, 1);
    assert.equal(run.core.images.list(listSchema.parse({ q: '秘密' })).total, 1);

    // The agent-facing projection: visible and non-archived only, text fields only.
    const library = run.core.images.listAgentVisible(listSchema.parse({}));
    assert.equal(library.total, 2);
    assert.deepEqual(
      library.items.map((item) => Object.keys(item).sort()),
      [
        ['category', 'description', 'id', 'keywords', 'name'],
        ['category', 'description', 'id', 'keywords', 'name'],
      ],
    );
    assert.equal(run.core.images.listAgentVisible(listSchema.parse({ q: '植物' })).total, 1);

    const visible = library.items.find((item) => item.name === '花园');
    assert.ok(visible !== undefined);
    assert.equal(run.core.images.getAgentVisible(visible.id)?.name, '花园');
    const secret = run.core.images.list(listSchema.parse({ q: '秘密' })).items[0];
    assert.ok(secret !== undefined);
    assert.equal(run.core.images.getAgentVisible(secret.id), null);
    assert.equal(run.core.images.getAgentVisible('00000000-0000-4000-8000-000000000000'), null);

    // Archiving a promoted asset removes it from the agent library at once.
    run.core.images.remove(visible.id);
    assert.equal(run.core.images.getAgentVisible(visible.id), null);
    assert.equal(run.core.images.listAgentVisible(listSchema.parse({})).total, 1);
  } finally {
    await run.cleanup();
  }
});

test('search treats underscore, percent and backslash as literals in every field', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    // Every special character lands in a different field, all seeded through
    // the metadata update path (keywords are not a creation field).
    const needle = await run.core.images.create({
      name: 'IMG_1234.png',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    run.core.images.update(needle.id, {
      description: '100% watercolor',
      category: 'back\\slash',
      keywords: 'hero_v2',
      agentVisible: true,
    });
    const decoy = await run.core.images.create({
      name: 'decoy',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    run.core.images.update(decoy.id, { keywords: 'heroXv2' });

    // Each special character must match itself, not act as a LIKE wildcard.
    for (const q of ['IMG_1234.png', 'hero_v2', '100% watercolor', 'back\\slash']) {
      assert.equal(run.core.images.list(listSchema.parse({ q })).total, 1, q);
    }
    // The escaped `_` does not match an arbitrary character.
    assert.equal(run.core.images.list(listSchema.parse({ q: 'IMGX1234Xpng' })).total, 0);
    assert.equal(run.core.images.list(listSchema.parse({ q: 'hero_v2' })).items[0]?.id, needle.id);
    void decoy;

    // The agent-facing projection shares the same literal predicate.
    assert.equal(run.core.images.listAgentVisible(listSchema.parse({ q: 'hero_v2' })).total, 1);
    assert.equal(run.core.images.listAgentVisible(listSchema.parse({ q: '100%' })).total, 1);
  } finally {
    await run.cleanup();
  }
});

test('image uploads reject SVG, mismatched mime, garbage and oversized payloads', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await assert.rejects(
      () =>
        run.core.images.create({
          name: 'svg',
          base64: svg.toString('base64'),
          mime: 'image/png',
          description: '',
          category: '',
          source: 'upload',
        }),
      (error: { code?: string }) => error.code === 'unsupported_format',
    );

    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    await assert.rejects(
      () =>
        run.core.images.create({
          name: 'mismatch',
          base64: jpeg.toString('base64'),
          mime: 'image/png',
          description: '',
          category: '',
          source: 'upload',
        }),
      (error: { code?: string }) => error.code === 'mime_mismatch',
    );

    await assert.rejects(
      () =>
        run.core.images.create({
          name: 'garbage',
          base64: 'not*base64!!',
          mime: 'image/png',
          description: '',
          category: '',
          source: 'upload',
        }),
      (error: { code?: string }) => error.code === 'invalid_base64',
    );

    // A declared PNG within schema limits that is not a decodable image.
    const notAnImage = Buffer.alloc(2048, 7);
    await assert.rejects(
      () =>
        run.core.images.create({
          name: 'not-image',
          base64: notAnImage.toString('base64'),
          mime: 'image/png',
          description: '',
          category: '',
          source: 'upload',
        }),
      (error: { code?: string }) => error.code === 'invalid_image',
    );

    const jpegUpload = await run.core.images.create({
      name: 'jpeg ok',
      base64: jpeg.toString('base64'),
      mime: 'image/jpeg',
      description: '',
      category: '',
      source: 'upload',
    });
    assert.equal(jpegUpload.mime, 'image/jpeg');
    assert.equal(jpegUpload.bytes, jpeg.length);
  } finally {
    await run.cleanup();
  }
});

test('unknown ids and archived assets fail with stable errors', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    assert.equal(run.core.images.get('not-a-uuid'), null);
    assert.equal(run.core.prompts.get('00000000-0000-4000-8000-000000000000'), null);
    assert.throws(
      () => run.core.prompts.update('00000000-0000-4000-8000-000000000000', { name: 'x' }),
      (error: { code?: string }) => error.code === 'not_found',
    );
    assert.throws(
      () => run.core.prompts.remove('00000000-0000-4000-8000-000000000000'),
      (error: { code?: string }) => error.code === 'not_found',
    );
  } finally {
    await run.cleanup();
  }
});

test('config snapshots validate models, credentials and cross references', async () => {
  const run = await createTestCore({ providerFetch: async () => new Response('{}', { status: 500 }) });
  try {
    assert.throws(() => run.core.config.current(), /config_invalid|模型配置/);
    assert.equal(run.core.config.hasValidConfig(), false);
    assert.equal(run.core.config.publicModels().length, 0);

    publishDefaultConfig(run.config);
    assert.equal(run.core.config.hasValidConfig(), true);
    assert.equal(run.core.config.current().models.length, 1);
    const firstPublicModel = run.core.config.publicModels()[0];
    assert.ok(firstPublicModel !== undefined);
    assert.ok(!('credentialRef' in firstPublicModel), '公共模型不暴露凭据引用');

    // Cross-reference checks: a model without its credential is rejected as a whole.
    const { createImageConfigSnapshot } = await import('../src/config.ts');
    assert.throws(() =>
      createImageConfigSnapshot({ version: 'v2', models: [defaultModelNoCredential()], credentials: {} }),
    );
  } finally {
    await run.cleanup();
  }
});

function defaultModelNoCredential() {
  return {
    id: 'orphan',
    name: 'Orphan',
    provider: 'openrouter' as const,
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'missing',
    providerTag: 'openai',
    capabilities: {
      imageInput: true,
      maxInputImages: 1,
      maxOutputs: 1,
      aspectRatios: ['auto', '1:1'],
      resolutionClasses: ['auto'],
    },
  };
}
