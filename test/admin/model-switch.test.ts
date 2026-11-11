import { readFile, writeFile } from 'node:fs/promises';
import { and, eq, ne } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { createControlAdminHandler } from '../../src/ingress/admin/control.ts';
import { createChatsAdminHandler } from '../../src/ingress/admin/routes/chats.ts';
import type { InvocationHandler } from '../../src/orchestration/scheduler/index.ts';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { resolveAgentSettings } from '../../src/platform/config/resolve.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { buckets, invocationBuckets, invocations } from '../../src/store/schema/index.ts';
import type { FixtureConfig } from '../helpers.ts';
import { type MemoFixture, seedChat } from '../memo/fixtures.ts';
import { cleanup, fixture, queue, useLifecycleCleanup } from './chats-lifecycle-fixtures.ts';

useLifecycleCleanup();

const PRIVATE_CHAT = 123456789;
const GROUP_WITH_OVERRIDE = -1001234567890;

/**
 * Runs that hold until released and remember, per Invocation, the abort reason
 * and the agent model the snapshot they started with resolves to — which is
 * the model the run would talk to.
 */
function gatedRuns() {
  const release = Promise.withResolvers<void>();
  cleanup.push(async () => release.resolve());
  const started = new Map<bigint, PromiseWithResolvers<void>>();
  const aborted = new Map<bigint, PromiseWithResolvers<string>>();
  const models = new Map<bigint, string>();
  const slot = <T>(map: Map<bigint, PromiseWithResolvers<T>>, id: bigint): PromiseWithResolvers<T> => {
    let entry = map.get(id);
    if (entry === undefined) {
      entry = Promise.withResolvers<T>();
      map.set(id, entry);
    }
    return entry;
  };
  return {
    release,
    started: (id: bigint) => slot(started, id).promise,
    aborted: (id: bigint) => slot(aborted, id).promise,
    models,
    handler:
      (f: MemoFixture): InvocationHandler =>
      async (id, snapshot, signal) => {
        const row = f.store.orm
          .select({ conversationId: invocations.conversationId })
          .from(invocations)
          .where(eq(invocations.id, id))
          .get();
        const chatId = row === undefined ? undefined : conversationChats.get(row.conversationId);
        const chat = snapshot.config.telegram.chats.find((entry) => entry.id === chatId);
        const agent = resolveAgentSettings(snapshot.config, chat);
        models.set(id, `${agent.provider}/${agent.model}`);
        signal.addEventListener(
          'abort',
          () =>
            slot(aborted, id).resolve(signal.reason instanceof Error ? signal.reason.message : String(signal.reason)),
          { once: true },
        );
        slot(started, id).resolve();
        await release.promise;
        return { state: signal.aborted ? 'aborted' : 'completed', reason: signal.aborted ? 'model_switched' : 'done' };
      },
  };
}

/** Which configured Chat each seeded Conversation belongs to, for resolving its model. */
const conversationChats = new Map<bigint, number>();

function withOverrideChat(config: FixtureConfig): void {
  config.telegram?.chats.push({
    id: GROUP_WITH_OVERRIDE,
    provider: 'vision',
    model: 'vision-model',
    thinking_level: 'off',
  });
}

async function switchFixture(runs: ReturnType<typeof gatedRuns>) {
  const f = await fixture(runs.handler, { transform: withOverrideChat });
  const chatsRoute = createChatsAdminHandler({
    store: f.store,
    configStore: f.configStore,
    configReloader: f.reloader,
    secrets: undefined,
    memoBlobs: f.blobs,
    scheduler: f.scheduler,
  });
  const control = createControlAdminHandler({
    store: f.store,
    configStore: f.configStore,
    configReloader: f.reloader,
    secrets: undefined,
    scheduler: f.scheduler,
    tasks: f.tasks,
    modelSwitcher: new AgentModelSwitcher(f.configStore),
    requestRestart: undefined,
  });
  const put = async (path: string, body: unknown): Promise<{ readonly status: number; readonly body: any }> => {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const request = new Request(`http://localhost/api/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': await f.reloader.revision() },
      body: JSON.stringify(body),
    });
    const response =
      segments[0] === 'chats'
        ? await chatsRoute.handle(request, segments)
        : await control.handle(request, segments, 'owner');
    if (response === undefined) {
      throw new Error(`PUT /api/${path} was not handled`);
    }
    return { status: response.status, body: await response.json() };
  };
  const file = async (): Promise<FileConfig> => JSON.parse(await readFile(f.loaded.configPath, 'utf8')) as FileConfig;
  const seed = (telegramChatId: number) => {
    const chat = seedChat(f.store, BigInt(telegramChatId));
    conversationChats.set(chat.conversationId, telegramChatId);
    return chat;
  };
  const state = (id: bigint) => f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get();
  return { ...f, put, file, seed, state };
}

/** A batch that arrived during the run: attached to it, not yet injected. */
function attachPendingBatch(f: MemoFixture, invocationId: bigint, conversationId: bigint): bigint {
  const now = new Date().toISOString();
  const bucket = f.store.orm
    .insert(buckets)
    .values({ conversationId, state: 'running', firstReceivedAt: now, deadlineAt: now, createdAt: now, updatedAt: now })
    .returning({ id: buckets.id })
    .get();
  if (bucket === undefined) {
    throw new Error('bucket insert returned no row');
  }
  f.store.orm.insert(invocationBuckets).values({ invocationId, bucketId: bucket.id, attachedAt: now }).run();
  return bucket.id;
}

test('a Chat model switch asks before stopping the run on the old model, and the next batch runs on the new one', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const chat = f.seed(PRIVATE_CHAT);
  const id = queue(f, chat.conversationId);
  const opening = f.state(id)?.bucketId;
  f.scheduler.start();
  await runs.started(id);
  expect(runs.models.get(id)).toBe('agent/agent-model');
  const pending = attachPendingBatch(f, id, chat.conversationId);

  // A thinking-level change keeps the model: nothing to stop, nothing asked.
  const effort = await f.put(`chats/${PRIVATE_CHAT}`, {
    topic_ids: null,
    provider: null,
    model: null,
    thinking_level: 'high',
  });
  expect(effort.status).toBe(200);
  expect(effort.body.aborted_invocations).toBe(0);
  expect(f.state(id)?.state).toBe('running');

  // A new model is refused while the run is still on the old one, and nothing
  // is written.
  const switchBody = { topic_ids: null, provider: 'vision', model: 'vision-model', thinking_level: 'off' };
  const refused = await f.put(`chats/${PRIVATE_CHAT}`, switchBody);
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: 'model_in_use', running_invocations: 1 });
  const unchanged = (await f.file()).telegram?.chats.find((entry) => entry.id === PRIVATE_CHAT);
  expect(unchanged).toMatchObject({ thinking_level: 'high' });
  expect(unchanged?.provider).toBeUndefined();
  expect(f.state(id)?.state).toBe('running');

  // Confirmed: written, applied, and the run is stopped at once.
  const confirmed = await f.put(`chats/${PRIVATE_CHAT}`, { ...switchBody, abort_running: true });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.aborted_invocations).toBe(1);
  expect(await runs.aborted(id)).toBe('model_switched');
  expect((await f.file()).telegram?.chats.find((entry) => entry.id === PRIVATE_CHAT)).toMatchObject({
    provider: 'vision',
    model: 'vision-model',
  });

  runs.release.resolve();
  expect(await f.scheduler.waitForInvocations([id])).toBe(true);
  expect(f.state(id)).toMatchObject({ state: 'aborted', completionReason: 'model_switched' });
  // The batch the run was answering is closed without a reply, never retried.
  expect(
    f.store.orm
      .select()
      .from(buckets)
      .where(eq(buckets.id, opening ?? 0n))
      .get()?.state,
  ).toBe('aborted');
  // The batch that only waited on the run goes to a new Invocation, which
  // starts on the new model.
  const retryOf = () =>
    f.store.orm
      .select({ id: invocations.id })
      .from(invocations)
      .where(and(eq(invocations.bucketId, pending), ne(invocations.id, id)))
      .get()?.id;
  await expect.poll(retryOf).toBeDefined();
  const retry = retryOf() ?? 0n;
  await runs.started(retry);
  expect(runs.models.get(retry)).toBe('vision/vision-model');
});

test('a global switch only stops runs that follow the global model', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const inherits = f.seed(PRIVATE_CHAT);
  const overridden = f.seed(GROUP_WITH_OVERRIDE);
  const following = queue(f, inherits.conversationId);
  const own = queue(f, overridden.conversationId);
  f.scheduler.start();
  await Promise.all([runs.started(following), runs.started(own)]);
  expect(runs.models.get(following)).toBe('agent/agent-model');
  expect(runs.models.get(own)).toBe('vision/vision-model');

  // The Chat with its own model is not running on the global one.
  const refused = await f.put('model', { provider: 'vision', model: 'vision-model' });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: 'model_in_use', running_invocations: 1 });
  expect((await f.file()).agent).toMatchObject({ provider: 'agent', model: 'agent-model' });

  const invalid = await f.put('model', { provider: 'vision', model: 'vision-model', abort_running: 'yes' });
  expect(invalid.status).toBe(400);

  const confirmed = await f.put('model', { provider: 'vision', model: 'vision-model', abort_running: true });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body).toMatchObject({
    aborted_invocations: 1,
    current: { provider: 'vision', model: 'vision-model' },
  });
  expect(await runs.aborted(following)).toBe('model_switched');
  expect(f.state(own)?.state).toBe('running');

  // Switching to the model a run already uses stops nothing.
  const same = await f.put('model', { provider: 'vision', model: 'vision-model' });
  expect(same.status).toBe(200);
  expect(same.body.aborted_invocations).toBe(0);

  runs.release.resolve();
  expect(await f.scheduler.waitForInvocations([following, own])).toBe(true);
  expect(f.state(following)).toMatchObject({ state: 'aborted', completionReason: 'model_switched' });
  expect(f.state(own)).toMatchObject({ state: 'completed' });
});

test('switching back preserves a run already using the target model after another configuration was applied', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const chat = f.seed(PRIVATE_CHAT);
  const id = queue(f, chat.conversationId);
  f.scheduler.start();
  await runs.started(id);
  const applied = await f.reloader.writeAndApply(
    [
      { path: ['agent', 'provider'], value: 'vision' },
      { path: ['agent', 'model'], value: 'vision-model' },
      { path: ['agent', 'thinking_level'], value: 'off' },
      { path: ['agent', 'max_concurrency'], value: f.configStore.current().config.agent.max_concurrency + 1 },
    ],
    await f.reloader.revision(),
  );
  expect(applied.ok).toBe(true);
  expect(runs.models.get(id)).toBe('agent/agent-model');

  const switched = await f.put('model', { provider: 'agent', model: 'agent-model', abort_running: true });
  expect(switched.status).toBe(200);
  expect(switched.body.aborted_invocations).toBe(0);
  runs.release.resolve();
  expect(await f.scheduler.waitForInvocations([id])).toBe(true);
  expect(f.state(id)).toMatchObject({ state: 'completed', completionReason: 'done' });
});

test('a model switch fences queued launches until the published model is ready', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const chat = f.seed(PRIVATE_CHAT);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  cleanup.unshift(async () => resume.resolve());
  const read = f.reloader.readPersisted.bind(f.reloader);
  vi.spyOn(f.reloader, 'readPersisted').mockImplementation(async (options) => {
    const loaded = await read(options);
    entered.resolve();
    await resume.promise;
    return loaded;
  });
  const switching = f.put('model', { provider: 'vision', model: 'vision-model' });
  await entered.promise;
  const id = queue(f, chat.conversationId);
  f.scheduler.start();
  resume.resolve();
  const result = await switching;
  if (result.status === 409) {
    expect(result.body).toMatchObject({ error: 'model_in_use', running_invocations: 1 });
    expect(f.configStore.current().config.agent.model).toBe('agent-model');
  } else {
    expect(result.status).toBe(200);
    await runs.started(id);
    expect(runs.models.get(id)).toBe('vision/vision-model');
  }
});

test('removing a Chat override checks the pending global model before writing anything', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const chat = f.seed(GROUP_WITH_OVERRIDE);
  const id = queue(f, chat.conversationId);
  f.scheduler.start();
  await runs.started(id);
  const file = await f.file();
  file.agent = { ...file.agent, provider: 'agent', model: 'agent-model', thinking_level: 'off' };
  await writeFile(f.loaded.configPath, JSON.stringify(file, null, 2));
  const revision = await f.reloader.revision();
  const result = await f.put(`chats/${GROUP_WITH_OVERRIDE}`, {
    topic_ids: null,
    provider: null,
    model: null,
    thinking_level: 'off',
  });
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ error: 'model_in_use', running_invocations: 1 });
  expect(await f.reloader.revision()).toBe(revision);
  expect(
    (await loadConfig(f.loaded.configPath)).config.telegram.chats.find((c) => c.id === GROUP_WITH_OVERRIDE)?.model,
  ).toBe('vision-model');
});

test('a published switch aborts old runs even when the publication hook fails', async () => {
  const runs = gatedRuns();
  const f = await switchFixture(runs);
  const chat = f.seed(PRIVATE_CHAT);
  const id = queue(f, chat.conversationId);
  f.scheduler.start();
  await runs.started(id);
  const reloader = new ConfigReloader({
    loaded: f.loaded,
    store: f.configStore,
    modelSwitcher: new AgentModelSwitcher(f.configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => {
      throw new Error('publication hook failed');
    },
  });
  const control = createControlAdminHandler({
    store: f.store,
    configStore: f.configStore,
    configReloader: reloader,
    secrets: undefined,
    scheduler: f.scheduler,
    tasks: f.tasks,
    modelSwitcher: new AgentModelSwitcher(f.configStore),
    requestRestart: undefined,
  });
  const response = await control.handle(
    new Request('http://localhost/api/model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': await reloader.revision() },
      body: JSON.stringify({ provider: 'vision', model: 'vision-model', abort_running: true }),
    }),
    ['model'],
    'owner',
  );
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: 'publish_incomplete' });
  expect(f.configStore.current().config.agent.model).toBe('vision-model');
  runs.release.resolve();
  expect(await f.scheduler.waitForInvocations([id])).toBe(true);
  expect(f.state(id)).toMatchObject({ state: 'aborted', completionReason: 'model_switched' });
});
