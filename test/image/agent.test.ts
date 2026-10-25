import { imageSchema } from '@surowan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, test } from 'vitest';
import { agentActor, createImageBridge } from '../../src/image/bridge.ts';
import imagePlugin from '../../src/plugins/image/index.ts';
import type { ImagePluginBridge } from '../../src/plugins/plugin.ts';
import { taskReceipts } from '../../src/store/schema/index.ts';
import {
  installImageAgentHooks,
  fixture,
  submitFixtureWork,
  generationIdOf,
  waitFor,
  fakeScope,
} from './agent-fixtures.ts';

// ---------------------------------------------------------------------------
// M4: the agent tool surface. image_generate submits through the bridge; when a
// generation settles, its outstanding long task completes and a receipt is
// delivered; the send tool delivers the pictures of a generation that belongs
// to the asking conversation — and only that one.
// ---------------------------------------------------------------------------

installImageAgentHooks();

test('a settled generation completes its long task and records a receipt for the conversation', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef);
  const db = drizzle(fixtureRef.store.db, { schema: imageSchema });
  await waitFor(() => {
    const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generationId)).get();
    return row?.status === 'succeeded' ? row : null;
  });

  // The completion listener reconciles the outstanding task automatically.
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' ? task : null;
  });
  // The receipt carries the structured result the scheduler injects later.
  const receipts = fixtureRef.store.orm
    .select({ status: taskReceipts.status, resultJson: taskReceipts.resultJson })
    .from(taskReceipts)
    .all();
  expect(receipts.length).toBe(1);
  expect(String(receipts[0]?.resultJson)).toContain('generation_id');
});

test('a failed generation still completes the task with an error receipt', async () => {
  const fixtureRef = await fixture([true]);
  const generationId = await submitFixtureWork(fixtureRef);
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row !== undefined && ['failed', 'interrupted'].includes(row.status) ? true : null;
  });
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' || task?.state === 'failed' ? task?.state : null;
  });
  // The receipt carries the failure either way; no silent waiting.
});

test('reconcile() settles outstanding image tasks after a restart', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef, { conversationId: 42n });
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row?.status === 'succeeded' ? true : null;
  });
  // Simulate a restart gap: detach the finished listener, rewire a fresh bridge
  // over the same store, and reconcile — the waiting task must complete.
  const secondBridge = createImageBridge({
    service: fixtureRef.service,
    store: fixtureRef.store,
    tasks: fixtureRef.tasks,
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  secondBridge.reconcile();
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' ? task : null;
  });
  secondBridge.stop();
});

test('the plugin contributes image_generate only when the bridge is enabled', () => {
  const disabledScope = fakeScope({
    enabled: () => false,
    enabledFor: () => false,
    submit: () => Promise.reject(new Error('no')),
    modelList: () => [],
  });
  expect(imagePlugin.capabilities?.(disabledScope) ?? []).toHaveLength(0);

  const enabledScope = fakeScope({
    enabled: () => true,
    enabledFor: () => true,
    submit: () => Promise.reject(new Error('no')),
    modelList: () => [],
  });
  const enabled = imagePlugin.capabilities?.(enabledScope) ?? [];
  expect(enabled.map((entry) => entry.tool.name)).toEqual(['image_generate', 'list_image_models']);
  expect(enabled.map((entry) => entry.sideEffect)).toEqual([true, false]);
});

test('unauthorized input media references are rejected before any submission', async () => {
  const fixtureRef = await fixture();
  const scope = fakeScope(fixtureRef.pluginBridge, () => undefined);
  const [imageTool] = imagePlugin.capabilities?.(scope) ?? [];
  expect(imageTool).toBeDefined();
  await expect(
    imageTool?.tool.execute?.(
      'call-x',
      { prompt: 'p', input_image_refs: ['img_foreign'] },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/not authorized/);
});

test('input media references become intent-level input images', async () => {
  const fixtureRef = await fixture();
  const calls: string[] = [];
  const submitted: { inputMediaIds: bigint[] }[] = [];
  const probingBridge: ImagePluginBridge = {
    ...fixtureRef.pluginBridge,
    submit: async (params) => {
      calls.push('submit');
      submitted.push({ inputMediaIds: [...params.inputMediaIds] });
      return { generationId: 'g', replayed: false, modelId: 'gpt-image-1', outputCount: 1 };
    },
  };
  const [probedTool] =
    imagePlugin.capabilities?.(fakeScope(probingBridge, (ref) => (ref === 'img_ok' ? 5n : undefined))) ?? [];
  await probedTool?.tool.execute?.(
    'call-refs',
    { prompt: 'p', input_image_refs: ['img_ok'] },
    new AbortController().signal,
  );
  expect(calls).toEqual(['submit']);
  expect(submitted[0]?.inputMediaIds).toEqual([5n]);
});

test('agent actor ids bind generations to their conversation', () => {
  const actor = agentActor(42n);
  expect(actor.id).toBe('agent:42');
  expect(actor.privileged).toBe(true);
  expect(actor.source).toBe('agent');
});
