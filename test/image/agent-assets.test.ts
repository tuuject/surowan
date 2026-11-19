import { imageSchema, type GenerationSnapshot } from '@surowan/image-service';
import { expect, test } from 'vitest';
import sharp from 'sharp';
import { createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { createImageBridge } from '../../src/image/bridge/index.ts';
import { AgentAssetUnavailableError } from '../../src/image/bridge/submission.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import imagePlugin from '../../src/plugins/image/index.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { type ImageAgentFixture, installImageAgentHooks, fixture, fakeScope } from './agent-fixtures.ts';

// ---------------------------------------------------------------------------
// The agent-facing asset library: `search_image_assets` lists only assets an
// administrator promoted (and did not archive), and `image_generate` reaches
// library assets only through `library_image_refs` or inline `{{image:…}}`
// references — every reached asset is re-checked on each use, before anything
// is created or billed.
// ---------------------------------------------------------------------------

installImageAgentHooks();

async function uploadAsset(
  fixtureRef: ImageAgentFixture,
  entry: { name: string; keywords?: string; description?: string },
): Promise<{ id: string }> {
  const created = await fixtureRef.service.core.images.create({
    name: entry.name,
    base64: (
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#101010' } })
        .png()
        .toBuffer()
    ).toString('base64'),
    mime: 'image/png',
    description: entry.description ?? '',
    category: '',
    source: 'upload',
  });
  if (entry.keywords !== undefined) {
    fixtureRef.service.core.images.update(created.id, { keywords: entry.keywords });
  }
  return { id: created.id };
}

/** The one generation submitted with this prompt, as a typed snapshot. */
function snapshotOf(fixtureRef: ImageAgentFixture, authoredPrompt: string): GenerationSnapshot {
  const row = fixtureRef.store.orm
    .select()
    .from(imageSchema.generations)
    .all()
    .find((candidate) => candidate.snapshot.authored.authoredPrompt === authoredPrompt);
  expect(row, `expected a generation submitted with ${authoredPrompt}`).toBeDefined();
  return row!.snapshot;
}

/** Promotes one uploaded asset so the agent can see and use it. */
async function promote(fixtureRef: ImageAgentFixture, id: string, patch: { keywords?: string } = {}): Promise<void> {
  fixtureRef.service.core.images.update(id, { agentVisible: true, ...patch });
}

/** The plugin's capabilities behind the real execute gateway, with a real audit. */
function scopedExecute(fixtureRef: ImageAgentFixture) {
  const audit = createToolAudit(fixtureRef.store, 7n);
  const scope = { ...fakeScope(fixtureRef.pluginBridge), audit };
  const execute = createExecuteTool({ audit, capabilities: imagePlugin.capabilities?.(scope) ?? [] });
  return { execute, audit };
}

function pageOf(result: { content: readonly { type: string; text?: string }[] }): {
  assets: readonly { id: string; name: string }[];
  total: number;
  next_offset: number | null;
} {
  const envelope = JSON.parse(result.content.find((entry) => entry.type === 'text')?.text ?? '{}');
  return JSON.parse(envelope.text);
}

test('search_image_assets returns only promoted, non-archived assets and audits the read', async () => {
  const fixtureRef = await fixture();
  const { execute } = scopedExecute(fixtureRef);
  const hero = await uploadAsset(fixtureRef, { name: '自设 小雨', keywords: '自设, 三视图' });
  await promote(fixtureRef, hero.id, { keywords: '自设, 三视图' });
  const style = await uploadAsset(fixtureRef, { name: '水彩背景', description: '柔和的水彩场景' });
  await promote(fixtureRef, style.id);
  const secret = await uploadAsset(fixtureRef, { name: '私下草图', keywords: '秘密' });
  const archived = await uploadAsset(fixtureRef, { name: '旧图' });
  await promote(fixtureRef, archived.id);
  fixtureRef.service.core.images.remove(archived.id);

  const all = pageOf(await execute.execute('search-all', { action: 'call', tool: 'search_image_assets', input: {} }));
  expect(all.total).toBe(2);
  expect(all.next_offset).toBeNull();
  // Same-millisecond creations share a createdAt, so the exact order is not
  // pinned here; membership is what the contract states.
  expect(new Set(all.assets.map((asset) => asset.id))).toEqual(new Set([hero.id, style.id]));
  expect(all.assets.map((asset) => Object.keys(asset).sort())).toEqual([
    ['category', 'description', 'id', 'keywords', 'name'],
    ['category', 'description', 'id', 'keywords', 'name'],
  ]);
  expect(JSON.stringify(all)).not.toContain('私下草图');
  expect(JSON.stringify(all)).not.toContain('旧图');

  // The query matches name, description, category and keywords.
  const byKeyword = pageOf(
    await execute.execute('search-kw', { action: 'call', tool: 'search_image_assets', input: { q: '三视图' } }),
  );
  expect(byKeyword.assets.map((asset) => asset.id)).toEqual([hero.id]);
  const byDescription = pageOf(
    await execute.execute('search-desc', { action: 'call', tool: 'search_image_assets', input: { q: '水彩' } }),
  );
  expect(byDescription.assets.map((asset) => asset.id)).toEqual([style.id]);

  const rows = fixtureRef.store.orm.select().from(toolCalls).all();
  expect(rows.filter((row) => row.toolName === 'search_image_assets').map((row) => row.state)).toEqual([
    'success',
    'success',
    'success',
  ]);
  expect(fixtureRef.calls).toHaveLength(0);
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
  void secret;
});

test('search_image_assets refuses invalid input and a disabled conversation', async () => {
  const fixtureRef = await fixture();
  const { execute } = scopedExecute(fixtureRef);
  // The execute gateway refuses schema-breaking input before dispatch. The
  // offset itself is unbounded (the pager may advertise any continuation), so
  // the invalid case is a negative one.
  await expect(
    execute.execute('bad-input', { action: 'call', tool: 'search_image_assets', input: { offset: -1 } }),
  ).rejects.toThrow(/does not match the schema of search_image_assets/);
  expect(fixtureRef.store.orm.select().from(toolCalls).all().at(-1)?.errorCode).toBe('invalid_arguments');

  fixtureRef.service.publishConfig(undefined);
  await expect(execute.execute('disabled', { action: 'call', tool: 'search_image_assets', input: {} })).rejects.toThrow(
    /not enabled/,
  );
  const last = fixtureRef.store.orm.select().from(toolCalls).all().at(-1);
  expect(last?.toolName).toBe('search_image_assets');
  expect(last?.errorCode).toBe('image_generation_disabled');
});

test('image_generate rejects a private, archived or unknown library asset before creating anything', async () => {
  const fixtureRef = await fixture();
  const { execute } = scopedExecute(fixtureRef);
  const privateAsset = await uploadAsset(fixtureRef, { name: '私有图' });
  const archivedAsset = await uploadAsset(fixtureRef, { name: '已归档图' });
  await promote(fixtureRef, archivedAsset.id);
  fixtureRef.service.core.images.remove(archivedAsset.id);

  const rejections = [
    { prompt: '画点东西', library_image_refs: [privateAsset.id] },
    { prompt: '画点东西', library_image_refs: [archivedAsset.id] },
    { prompt: '画点东西', library_image_refs: ['00000000-0000-4000-8000-000000000000'] },
    { prompt: `参考这张 {{image:${privateAsset.id}}}` },
    { prompt: `参考这张 {{image:${archivedAsset.id}}}` },
  ] as const;
  for (const [index, input] of rejections.entries()) {
    await expect(execute.execute(`reject-${index}`, { action: 'call', tool: 'image_generate', input })).rejects.toThrow(
      /not available to the agent/,
    );
    // Nothing was created or billed: no generation, no task, no provider call.
    expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
    expect(fixtureRef.tasks.scoped('image', 42n).list()).toHaveLength(0);
    expect(fixtureRef.calls).toHaveLength(0);
  }
  const rejectionRows = fixtureRef.store.orm
    .select()
    .from(toolCalls)
    .all()
    .filter((row) => row.toolName === 'image_generate');
  expect(rejectionRows).toHaveLength(5);
  expect(new Set(rejectionRows.map((row) => row.errorCode))).toEqual(new Set(['image_asset_unauthorized']));
});

test('a promoted asset submits through library_image_refs and lands in the ordered inputs', async () => {
  const fixtureRef = await fixture();
  const { execute } = scopedExecute(fixtureRef);
  const hero = await uploadAsset(fixtureRef, { name: '自设 小雨' });
  await promote(fixtureRef, hero.id, { keywords: '自设' });
  const background = await uploadAsset(fixtureRef, { name: '水彩背景' });
  await promote(fixtureRef, background.id);

  const result = await execute.execute('submit-explicit', {
    action: 'call',
    tool: 'image_generate',
    input: { prompt: '画我的自设', library_image_refs: [hero.id, background.id] },
  });
  expect(result.content.find((entry) => entry.type === 'text')?.text).toContain('submitted');
  const explicit = snapshotOf(fixtureRef, '画我的自设');
  expect(explicit.imageAssets.map((asset) => asset.id)).toEqual([hero.id, background.id]);
  expect(explicit.finalPrompt).toBe('画我的自设');

  // Inline references label in place and fix the order before the explicit list.
  const inlinePrompt = `三视图用 {{image:${hero.id}}}，背景参考 {{image:${background.id}}}`;
  await execute.execute('submit-inline', {
    action: 'call',
    tool: 'image_generate',
    input: { prompt: inlinePrompt, library_image_refs: [background.id] },
  });
  const inline = snapshotOf(fixtureRef, inlinePrompt);
  expect(inline.imageAssets.map((asset) => asset.id)).toEqual([hero.id, background.id]);
  expect(inline.finalPrompt).toBe('三视图用 图 1，背景参考 图 2');
});

test('a demotion during input preparation still refuses before anything is created', async () => {
  const fixtureRef = await fixture();
  const hero = await uploadAsset(fixtureRef, { name: '自设 小雨' });
  await promote(fixtureRef, hero.id);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#101010' } })
    .png()
    .toBuffer();
  const tasks = new LongTaskService(fixtureRef.store.orm, () => undefined);
  // The conversation media is converted while an admin demotes the asset; the
  // submit must refuse at the creation gate, not queue a paid generation.
  const raceBridge = createImageBridge({
    service: fixtureRef.service,
    store: fixtureRef.store,
    tasks,
    prepareInputImage: async () => {
      fixtureRef.service.core.images.update(hero.id, { agentVisible: false });
      return { base64: png.toString('base64'), mime: 'image/png' };
    },
  });
  try {
    await expect(
      raceBridge.submit({
        conversationId: 42n,
        invocationId: null,
        toolCallId: 'call-mid-flight',
        authoredPrompt: '画我的自设',
        modelId: undefined,
        aspectRatio: undefined,
        resolution: undefined,
        outputCount: 1,
        inputMediaIds: [1n],
        libraryAssetIds: [hero.id],
        extendedData: undefined,
      }),
    ).rejects.toThrow(AgentAssetUnavailableError);
    expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
    expect(tasks.scoped('image', 42n).list()).toHaveLength(0);
    expect(fixtureRef.calls).toHaveLength(0);
  } finally {
    raceBridge.stop();
  }
});

test('search_image_assets accepts every offset its own pager advertises', async () => {
  const fixtureRef = await fixture();
  // 105 promoted assets: the page at offset 100 advertises a continuation the
  // old schema cap rejected. Seeded through persist, so no image decoding runs.
  for (let index = 0; index < 105; index += 1) {
    const id = `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;
    fixtureRef.service.core.images.persist(
      { id, fileName: `${id}.png`, mime: 'image/png', width: 2, height: 2, bytes: 3, sha256: id },
      { name: `Asset ${String(index)}`, description: '', category: '', source: 'upload' },
    );
    fixtureRef.service.core.images.update(id, { agentVisible: true });
  }
  const { execute } = scopedExecute(fixtureRef);
  let offset: number | null = 100;
  let seen = 0;
  while (offset !== null) {
    const result = await execute.execute(`page-${offset}`, {
      action: 'call',
      tool: 'search_image_assets',
      input: { offset },
    });
    const page = pageOf(result);
    expect(page.total).toBe(105);
    expect(page.assets.length).toBeGreaterThan(0);
    seen += page.assets.length;
    offset = page.next_offset;
  }
  // Only the rows past offset 100 were walked; they all paged through.
  expect(seen).toBe(5);
});

test('the bridge exposes the whole promoted library, not one page', async () => {
  const fixtureRef = await fixture();
  for (let index = 0; index < 35; index += 1) {
    const id = `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;
    fixtureRef.service.core.images.persist(
      { id, fileName: `${id}.png`, mime: 'image/png', width: 2, height: 2, bytes: 3, sha256: id },
      { name: `Asset ${String(index)}`, description: '', category: '', source: 'upload' },
    );
    fixtureRef.service.core.images.update(id, { agentVisible: true });
  }
  const library = fixtureRef.bridge.agentAssetLibrary();
  expect(library).toHaveLength(35);
  // The old wiring read a single default page; the row past position 30 must be here.
  expect(library.some((asset) => asset.id.endsWith('000000000034'))).toBe(true);
});

test('the bridge refuses a library asset demoted between the search and the submit', async () => {
  const fixtureRef = await fixture();
  const hero = await uploadAsset(fixtureRef, { name: '自设 小雨' });
  await promote(fixtureRef, hero.id);

  // The search saw the asset, an admin demoted it, and only then the submit ran.
  const visible = fixtureRef.pluginBridge.agentAsset(hero.id);
  expect(visible?.id).toBe(hero.id);
  fixtureRef.service.core.images.update(hero.id, { agentVisible: false });
  await expect(
    fixtureRef.bridge.submit({
      conversationId: 42n,
      invocationId: null,
      toolCallId: 'call-race',
      authoredPrompt: '画我的自设',
      modelId: undefined,
      aspectRatio: undefined,
      resolution: undefined,
      outputCount: 1,
      inputMediaIds: [],
      libraryAssetIds: [hero.id],
      extendedData: undefined,
    }),
  ).rejects.toThrow(AgentAssetUnavailableError);
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
  expect(fixtureRef.tasks.scoped('image', 42n).list()).toHaveLength(0);
  expect(fixtureRef.calls).toHaveLength(0);
});
