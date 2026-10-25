import { imageSchema } from '@surowan/image-service';
import { expect, test } from 'vitest';
import { createListImageModelsTool } from '../../src/plugins/image/image.ts';
import { taskReceipts, toolCalls } from '../../src/store/schema/index.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { installImageAgentHooks, fixture, waitFor, fakeScope, modelDirectoryFixture } from './agent-fixtures.ts';

// ---------------------------------------------------------------------------
// M4 (model directory): list_image_models paging and live notes, plus
// image_generate routing pinned to an explicit model choice.
// ---------------------------------------------------------------------------

installImageAgentHooks();

test('model discovery exposes live notes and capabilities without generating or exposing credentials', async () => {
  const fixtureRef = await fixture();
  const { models, publish, execute } = modelDirectoryFixture(fixtureRef);
  const result = await execute.execute('list-models', { action: 'call', tool: 'list_image_models', input: {} });
  const envelope = JSON.parse(result.content.find((entry) => entry.type === 'text')!.text);
  const page = JSON.parse(envelope.text);
  expect(page).toEqual({
    models: models.map(({ credentialRef: _ignored, ...model }) => model),
    total: 2,
    next_offset: null,
  });
  expect(envelope.text).not.toMatch(/credentialRef|credentials|sk-image-v1|sk-illustration-fixture|illustration-key/);
  expect(fixtureRef.calls).toHaveLength(0);
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
  expect(fixtureRef.tasks.scoped('image', 42n).list()).toHaveLength(0);
  const rows = fixtureRef.store.orm.select().from(toolCalls).all();
  expect(rows.map(({ toolName, state, sideEffect }) => ({ toolName, state, sideEffect }))).toEqual([
    { toolName: 'execute', state: 'success', sideEffect: false },
    { toolName: 'list_image_models', state: 'success', sideEffect: false },
  ]);
  expect(rows[1]?.resultText).toBe(envelope.text);

  publish([{ ...models[1]!, description: 'Updated guidance after hot reload.' }]);
  const updated = await execute.execute('list-updated', { action: 'call', tool: 'list_image_models', input: {} });
  const updatedPage = JSON.parse(JSON.parse(updated.content.find((entry) => entry.type === 'text')!.text).text);
  expect(updatedPage.models).toHaveLength(1);
  expect(updatedPage.models[0]).toMatchObject({
    id: 'illustration',
    description: 'Updated guidance after hot reload.',
  });
  fixtureRef.service.publishConfig(undefined);
  await expect(
    execute.execute('list-disabled', { action: 'call', tool: 'list_image_models', input: {} }),
  ).rejects.toThrow(/not enabled/);
  expect(fixtureRef.store.orm.select().from(toolCalls).all().at(-1)?.errorCode).toBe('image_generation_disabled');
});

test('all image model pages survive the execute byte budget, including long escaped notes', async () => {
  const fixtureRef = await fixture();
  const { models, publish, execute } = modelDirectoryFixture(fixtureRef);
  const description = '\u0000'.repeat(1000);
  publish(
    Array.from({ length: 64 }, (_, index) => ({
      ...models[0]!,
      id: `image-${index}-${'m'.repeat(70)}`,
      name: '\u0000'.repeat(80),
      upstreamModel: `example/${'m'.repeat(200)}`,
      providerTag: `${'p'.repeat(80)}/${'p'.repeat(80)}`,
      description,
    })),
  );
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await execute.execute(`page-${offset}`, {
      action: 'call',
      tool: 'list_image_models',
      input: { offset },
    });
    const text = result.content.find((entry) => entry.type === 'text')!.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    const page = JSON.parse(JSON.parse(text).text);
    expect(page.total).toBe(64);
    expect(page.models).toHaveLength(Math.min(3, 64 - ids.length));
    for (const model of page.models) {
      expect(model.description).toBe(description);
      ids.push(model.id);
    }
    offset = page.next_offset;
  }
  expect(ids).toEqual(Array.from({ length: 64 }, (_, index) => `image-${index}-${'m'.repeat(70)}`));
  for (const [index, input] of [{ offset: -1 }, { offset: 0.5 }, { offset: 101 }, { model_id: 'bad' }].entries()) {
    await expect(
      execute.execute(`invalid-page-${index}`, { action: 'call', tool: 'list_image_models', input }),
    ).rejects.toThrow(/schema/);
  }
  const empty = await execute.execute('past-last-page', {
    action: 'call',
    tool: 'list_image_models',
    input: { offset: 100 },
  });
  expect(JSON.parse(JSON.parse(empty.content.find((entry) => entry.type === 'text')!.text).text)).toEqual({
    models: [],
    total: 64,
    next_offset: null,
  });
  publish([{ ...models[0]!, upstreamModel: `example/${'m'.repeat(40_000)}` }]);
  await expect(
    execute.execute('oversized-model', {
      action: 'call',
      tool: 'list_image_models',
      input: {},
    }),
  ).rejects.toThrow(/metadata is too large/);
  expect(fixtureRef.store.orm.select().from(toolCalls).all().at(-1)).toMatchObject({
    state: 'error',
    sideEffect: false,
    errorCode: 'list_image_models_error',
  });
  expect(fixtureRef.calls).toHaveLength(0);
});

test('direct catalog calls audit invalid input and cancellation without reading models', async () => {
  const fixtureRef = await fixture();
  let reads = 0;
  const tool = createListImageModelsTool({
    ...fakeScope({
      ...fixtureRef.pluginBridge,
      modelList: () => {
        reads += 1;
        return fixtureRef.bridge.modelList();
      },
    }),
    audit: createToolAudit(fixtureRef.store, 7n),
  });
  await expect(tool.execute('bad-direct', { offset: -1 })).rejects.toThrow(/input is invalid/);
  await expect(tool.execute('abort-direct', {}, AbortSignal.abort())).rejects.toThrow();
  expect(reads).toBe(0);
  expect(fixtureRef.store.orm.select().from(toolCalls).all()).toEqual([
    expect.objectContaining({ state: 'error', sideEffect: false, errorCode: 'list_image_models_input_invalid' }),
    expect.objectContaining({ state: 'error', sideEffect: false, errorCode: 'aborted' }),
  ]);
});

test('explicit model selection pins its route, prompt and receipt; invalid choices never generate', async () => {
  const fixtureRef = await fixture();
  const { models, publish, execute } = modelDirectoryFixture(fixtureRef);
  const prompt = '1girl, watercolor, blue hair, harbor at dusk';
  for (const [index, input] of [
    { prompt },
    { prompt, model_id: 'missing' },
    { prompt, model_id: 'illustration', output_count: 2 },
    { prompt, model_id: 'illustration', aspect_ratio: '16:9' },
  ].entries()) {
    await expect(
      execute.execute(`invalid-model-${index}`, { action: 'call', tool: 'image_generate', input }),
    ).rejects.toThrow();
  }
  expect(fixtureRef.calls).toHaveLength(0);
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(0);
  expect(
    fixtureRef.store.orm
      .select()
      .from(toolCalls)
      .all()
      .filter((row) => row.toolName === 'image_generate'),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'error', errorCode: 'image_generate_error' })]));

  const submitted = await execute.execute('chosen-model', {
    action: 'call',
    tool: 'image_generate',
    input: { prompt, model_id: 'illustration' },
  });
  expect(submitted.content.find((entry) => entry.type === 'text')!.text).toContain('illustration');
  const generation = await waitFor(() => {
    const row = fixtureRef.store.orm.select().from(imageSchema.generations).get();
    return row?.status === 'succeeded' ? row : null;
  });
  expect(fixtureRef.calls).toHaveLength(1);
  expect(fixtureRef.calls[0]).toMatchObject({
    headers: { authorization: 'Bearer sk-illustration-fixture' },
    body: {
      model: 'example/illustration',
      prompt,
      n: 1,
      provider: { only: ['illustration-provider'], allow_fallbacks: false },
    },
  });
  expect(fixtureRef.calls[0]?.body).not.toHaveProperty('description');
  expect(JSON.stringify(fixtureRef.calls[0]?.body)).not.toContain(models[1]?.description);
  expect(generation.snapshot.model.id).toBe('illustration');
  expect(generation.snapshot.authored.authoredPrompt).toBe(prompt);
  const receipt = fixtureRef.store.orm.select().from(taskReceipts).get();
  expect(JSON.parse(receipt!.resultJson!)).toMatchObject({
    generation_id: generation.id,
    model_id: 'illustration',
    status: 'succeeded',
  });
  const success = fixtureRef.store.orm
    .select()
    .from(toolCalls)
    .all()
    .find((row) => row.toolCallId === 'chosen-model:image_generate');
  expect(success).toMatchObject({ state: 'success', sideEffect: true });
  expect(success?.resultText).toContain('model=illustration');

  publish([models[0]!]);
  await expect(
    execute.execute('removed-model', {
      action: 'call',
      tool: 'image_generate',
      input: { prompt, model_id: 'illustration' },
    }),
  ).rejects.toThrow();
  expect(fixtureRef.calls).toHaveLength(1);
});
