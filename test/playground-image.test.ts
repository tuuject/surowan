/**
 * Room image generation: opt-in, receipts and virtual picture output.
 *
 * The acceptance chain runs through the real assembly the composition root
 * uses — `createImageService`, `createImageBridge`, `loadPlugins(BUILTIN_PLUGINS)`,
 * `createHostTooling`, `createCoreRuntime`, `PlaygroundStore`, `PlaygroundIngress`,
 * `PlaygroundAssetStore` and the real system-skill tree. Only the image
 * provider's HTTP transport is a fake, and no Telegram transport exists at
 * all: a room picture can only come from the local asset store.
 *
 * Contracts under test:
 *  - a room without its image switch offers no `image_generate` capability, no
 *    image skill and no submission path, and spends nothing when refused;
 *  - flipping the switch changes the skill index, the copied prompt, the
 *    `execute` registry and paid submission together, and closing it only
 *    blocks new submissions;
 *  - a finished generation becomes a receipt, and `send kind:image` publishes
 *    the picture into the room with its ledger, media rows and assets;
 *  - reconciliation never settles a generation that can still run, and a
 *    process never executes or recovers a host's work it does not serve;
 *  - message retention never deletes the generation archive or an unhandled
 *    receipt, and the room's copy of a picture outlives its last reference only.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createOpenRouterAdapter } from '@plasticwan/image-service';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { backupDatabase, SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createHostTooling, imageDeliveryResolver } from '../src/adapters/local-monolith/host-tooling.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { resolveConversation } from '../src/adapters/local-monolith/runtime-host.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, FileSystemResources } from '../src/adapters/local-monolith/system-resources.ts';
import { PlaygroundAssetStore } from '../src/capabilities/media/local-assets.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { MemoryStore } from '../src/context/memory.ts';
import { createImageBridge } from '../src/image/bridge.ts';
import { generationEligibilityForHosts } from '../src/image/host-eligibility.ts';
import { createImageService } from '../src/image/service.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { createCoreRuntime } from '../src/orchestration/runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { unavailableCapabilities, type InvocationContext } from '../src/platform/invocation-context.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import type { SystemSkill } from '../src/platform/system-resources.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import {
  chats,
  conversations,
  dailyUsage,
  hostSends,
  imageGenerationAttempts,
  imageGenerations,
  invocations,
  longTasks,
  media,
  messageRevisions,
  messages,
  taskReceipts,
} from '../src/store/schema.ts';
import { purgeExpiredData } from '../src/store/store.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

const directories: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  let failure: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  if (failure !== undefined) {
    throw failure;
  }
});

/** A real PNG the fake provider returns, so the room store validates for real. */
async function providerPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 7, g: 8, b: 9 } } })
    .png()
    .toBuffer();
}

function providerResponse(image: Buffer): Response {
  return new Response(
    JSON.stringify({ created: 0, data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] }),
    { status: 200 },
  );
}

async function writeImageFixture(directory: string, configPath: string, maxConcurrency?: number): Promise<void> {
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent.send_nudge_enabled = false;
      config.agent.context.idle_grace_seconds = 0;
      if (maxConcurrency !== undefined) {
        config.agent.max_concurrency = maxConcurrency;
      }
      (config as Record<string, unknown>).image = {
        credentials: { openrouter: { jar: 'openrouter' } },
        models: [
          {
            id: 'gpt-image-1',
            name: 'GPT Image 1',
            provider: 'openrouter',
            upstreamModel: 'openai/gpt-image-1',
            credentialRef: 'openrouter',
            providerTag: 'openai',
            capabilities: {
              imageInput: true,
              maxInputImages: 2,
              maxOutputs: 4,
              aspectRatios: ['auto', '1:1'],
              resolutionClasses: ['auto', 'high'],
            },
          },
        ],
      };
    }),
  );
  await writeTestKeyJar(directory, {
    openrouter: 'sk-image-v1',
    agent: 'sk-agent',
    vision: 'sk-vision',
    telegram: 't',
  });
}

interface FixtureOptions {
  /** Runs before the provider request; an unresolved promise holds the call. */
  readonly beforeProvider?: () => Promise<void> | undefined;
  /** Overrides the agent concurrency so a test can fill the only slot. */
  readonly maxConcurrency?: number;
}

async function playgroundImageFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeImageFixture(directory, configPath, options.maxConcurrency);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(() => store.close());
  const providerCalls: unknown[] = [];
  const providerFetch: typeof fetch = async (_input, init) => {
    await options.beforeProvider?.();
    providerCalls.push(JSON.parse(String(init?.body)));
    return providerResponse(await providerPng());
  };
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({ fetchImpl: providerFetch }),
  });
  cleanups.push(() => service.stop());
  service.publishConfig(await service.prepareConfig(loaded.config, new SecretStore(keyJarPath(configPath))));
  const tasks = new LongTaskService(store.orm);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => {
      const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 3, g: 3, b: 3 } } })
        .png()
        .toBuffer();
      return { base64: png.toString('base64'), mime: 'image/png' };
    },
  });
  cleanups.push(() => bridge.stop());
  // The production layout: room assets live inside the backed-up image tree.
  const assets = new PlaygroundAssetStore({
    orm: store.orm,
    root: join(loaded.config.data_dir, 'images', 'playground'),
  });
  const plugins = loadPlugins(BUILTIN_PLUGINS, { image: bridge });
  const resources = await FileSystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR, plugins.skillDirectories);
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: { download: () => Promise.reject(new Error('this process has no media wire')) },
    modelGate: new KeyedSemaphore(),
    localAssets: assets,
  });
  const tooling = createHostTooling({
    store,
    configStore,
    plugins,
    media,
    memory: new MemoryStore(store.orm),
    tasks,
    imageBridge: bridge,
  });
  const playground = new PlaygroundStore(store.orm);
  const room = playground.createRoom({ title: 'Room', members: [{ name: 'Ada', role: 'admin' }] });
  const ingress = new PlaygroundIngress(store.orm, { assets });
  const host = createPlaygroundHost({
    store,
    self: { displayName: 'Plastic Wan' },
    pictures: assets,
    sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
  });
  const core = createCoreRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    host,
    conversation: (target) => resolveConversation(store, target),
    bot: { id: 999n, displayName: 'Plastic Wan', username: null },
    systemResources: resources,
    capabilityTools: tooling.capabilityTools,
    additionalTools: tooling.additionalTools,
    skillVisibility: tooling.skillVisible,
    imageGeneration: imageDeliveryResolver(bridge),
    tasks,
  });
  return {
    directory,
    config: loaded.config,
    store,
    configStore,
    service,
    bridge,
    assets,
    tooling,
    plugins,
    resources,
    playground,
    ingress,
    room,
    runtime: core.runtime,
    scheduler: core.scheduler,
    tasks,
    faux,
    providerCalls,
  };
}

type Fixture = Awaited<ReturnType<typeof playgroundImageFixture>>;

const IMAGE_SKILL: SystemSkill = {
  name: 'image-generation',
  description: '',
  uri: 'system:///skills/image-generation/SKILL.md',
};

function enableRoomImage(f: Fixture, enabled: boolean): void {
  f.playground.setImageEnabled(f.room.chatId, {
    enabled,
    actor: 'admin',
    revision: f.playground.room(f.room.chatId).revision,
  });
}

/** One held room input released into a queued invocation. */
function releaseRoomInput(f: Fixture, requestKey: string): bigint {
  const submitted = f.playground.submit(f.room.chatId, {
    requestKey,
    senderId: f.room.members[0]!.senderId,
    text: 'please draw something',
  });
  const release = f.playground.release(f.room.chatId, {
    releaseKey: `${requestKey}-release`,
    revision: submitted.revision,
  });
  if (release.invocationId === null) {
    throw new Error('expected a queued invocation');
  }
  return release.invocationId;
}

function runInvocation(f: Fixture, invocationId: bigint) {
  return f.runtime.run(invocationId, f.configStore.beginInvocation(), new AbortController().signal);
}

function roomToolContext(f: Fixture, invocationId: bigint): InvocationContext {
  return {
    invocationId,
    conversationId: f.room.conversationId,
    hostKind: 'playground',
    chatId: f.room.chatId,
    threadId: 0n,
    systemPrompt: '',
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: null,
    completion: null,
    omittedNewMessages: 0,
  };
}

function capabilityToolNames(f: Fixture, invocationId: bigint): string[] {
  return f.tooling
    .capabilityTools(roomToolContext(f, invocationId), Date.now() + 60_000, unavailableCapabilities())
    .map((entry) => entry.tool.name)
    .sort();
}

/** The stable prompt the composition root would build for one room invocation. */
function roomSystemPrompt(f: Fixture, invocationId: bigint): string {
  const builder = new ContextBuilder(f.store, new ContextRefStore(f.store, { ttlHours: () => 72 }), f.resources.skills);
  const config = f.configStore.current().config;
  const identity = builder.identity(config, invocationId);
  return builder.buildSystemPrompt(
    config,
    identity,
    false,
    { provider: 'agent', model: 'agent-model' },
    {
      skillFilter: (skill) =>
        f.tooling.skillVisible(skill, { hostKind: 'playground', conversationId: f.room.conversationId }),
    },
  ).systemPrompt;
}

function generationRows(f: Fixture) {
  return f.store.orm.select().from(imageGenerations).all();
}

function taskRows(f: Fixture) {
  return f.store.orm.select().from(longTasks).all();
}

function receiptRows(f: Fixture) {
  return f.store.orm.select().from(taskReceipts).all();
}

/** Messages the bot published into the room (the inputs are not output). */
function roomMessages(f: Fixture) {
  return f.store.orm
    .select()
    .from(messages)
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.currentRevisionId))
    .where(and(eq(messages.chatId, f.room.chatId), eq(messages.sentByBot, true)))
    .all();
}

async function settledGeneration(f: Fixture): Promise<string> {
  await expect.poll(() => generationRows(f)[0]?.id).toBeDefined();
  const generationId = generationRows(f)[0]!.id;
  await expect.poll(() => generationRows(f)[0]?.status).toBe('succeeded');
  return generationId;
}

async function settledTask(f: Fixture): Promise<void> {
  await expect.poll(() => taskRows(f)[0]?.state).toBe('completed');
}

async function pendingReceiptInvocation(f: Fixture): Promise<bigint> {
  await expect.poll(() => receiptRows(f)[0]?.state).toBe('pending');
  const [invocationId] = f.scheduler.processTasksDue();
  if (invocationId === undefined) {
    throw new Error('expected a receipt invocation');
  }
  return invocationId;
}

/** Submits one generation for the room conversation at a fixed invocation id. */
function submitGeneration(f: Fixture, invocationId: bigint | null, toolCallId: string) {
  return f.bridge.submit({
    conversationId: f.room.conversationId,
    invocationId,
    toolCallId,
    authoredPrompt: `picture ${toolCallId}`,
    modelId: undefined,
    aspectRatio: undefined,
    resolution: undefined,
    outputCount: undefined,
    inputMediaIds: [],
    extendedData: undefined,
  });
}

/** Runs one released input through the model: submit a generation, then stop. */
async function submitThroughRun(f: Fixture, invocationId: bigint, callId: string): Promise<string> {
  f.faux.setResponses([
    () =>
      fauxAssistantMessage(
        fauxToolCall(
          'execute',
          { action: 'call', tool: 'image_generate', input: { prompt: 'a quiet harbor' } },
          { id: callId },
        ),
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage('submitted'),
  ]);
  const outcome = await runInvocation(f, invocationId);
  expect(outcome.state).toBe('completed');
  return await settledGeneration(f);
}

/** Runs the receipt round: the model publishes the picture into the room. */
async function publishThroughReceipt(
  f: Fixture,
  callId: string,
  extra: { readonly generationId: string; readonly text?: string },
): Promise<void> {
  const args =
    extra.text === undefined
      ? { kind: 'image', image_generation_id: extra.generationId }
      : { kind: 'image', image_generation_id: extra.generationId, text: extra.text };
  f.faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall('send', args, { id: callId }), { stopReason: 'toolUse' }),
    () => fauxAssistantMessage('sent'),
  ]);
  const outcome = await runInvocation(f, await pendingReceiptInvocation(f));
  expect(outcome.state).toBe('completed');
}

describe('playground image generation', () => {
  test('a room without the image switch offers no tools, no skill and refuses the submission', async () => {
    const f = await playgroundImageFixture();
    expect(f.playground.room(f.room.chatId).imageEnabled).toBe(false);
    const invocationId = releaseRoomInput(f, 'ask-disabled');

    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      false,
    );
    expect(capabilityToolNames(f, invocationId)).not.toContain('image_generate');
    const prompt = roomSystemPrompt(f, invocationId);
    expect(prompt).toContain('web-fetch');
    expect(prompt).not.toContain('image-generation');

    await expect(submitGeneration(f, null, 'call-1')).rejects.toThrow('image generation is disabled');
    expect(generationRows(f)).toEqual([]);
    expect(taskRows(f)).toEqual([]);
    expect(f.providerCalls).toEqual([]);
  });

  test('the switch flips the skill index, the copied prompt, the registry and paid submission together', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-flip');
    enableRoomImage(f, true);
    const enabledRoom = f.playground.room(f.room.chatId);
    expect(enabledRoom).toMatchObject({ imageEnabled: true, imageEnabledBy: 'admin' });
    expect(enabledRoom.imageEnabledAt).not.toBeNull();

    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      true,
    );
    const names = capabilityToolNames(f, invocationId);
    expect(names).toContain('image_generate');
    expect(names).toContain('list_image_models');
    // The room's copied prompt carries the skill index, and it changes with the
    // switch; a skill the Playground never shows stays hidden either way.
    expect(roomSystemPrompt(f, invocationId)).toContain('image-generation');
    expect(
      f.tooling.skillVisible(
        { name: 'alarms', description: '', uri: '' },
        { hostKind: 'playground', conversationId: f.room.conversationId },
      ),
    ).toBe(false);

    enableRoomImage(f, false);
    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      false,
    );
    expect(capabilityToolNames(f, invocationId)).not.toContain('image_generate');
    expect(roomSystemPrompt(f, invocationId)).not.toContain('image-generation');
  });

  test('a generation finishes into a receipt and the room publishes the picture', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-1');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-1');
    await settledTask(f);
    await publishThroughReceipt(f, 'send-1', { generationId, text: 'the harbor' });

    const published = roomMessages(f);
    expect(published).toHaveLength(1);
    expect(published[0]!.message_revisions.kind).toBe('image');
    expect(published[0]!.message_revisions.caption).toBe('the harbor');
    const mediaRows = f.store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]).toMatchObject({ kind: 'photo', mimeType: 'image/png', hostKind: 'playground' });
    const stored = f.assets.resolve(mediaRows[0]!.localAssetId!);
    expect(stored).not.toBeNull();
    await expect(stat(stored!.path)).resolves.toBeDefined();

    // The ledger names the published room message, not a wire id.
    const sends = f.store.orm.select().from(hostSends).all();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      state: 'success',
      messageId: published[0]!.messages.id,
      telegramMessageId: null,
    });

    // The room's own usage is metered under the playground scope, never chat.
    const usage = f.store.orm.select().from(dailyUsage).all();
    expect(usage.some((row) => row.scope === 'playground' && row.metric === 'model_tokens')).toBe(true);
    expect(usage.filter((row) => row.scope === 'chat')).toEqual([]);
  });

  test('closing the switch only blocks new submissions; an accepted generation still lands', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-close');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-close');

    enableRoomImage(f, false);
    await expect(submitGeneration(f, null, 'call-refused')).rejects.toThrow('image generation is disabled');
    expect(generationRows(f)).toHaveLength(1);

    await settledTask(f);
    await publishThroughReceipt(f, 'send-closed', { generationId });
    expect(roomMessages(f)).toHaveLength(1);
  });

  test('a quota refusal creates no generation and starts no provider call', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-quota');
    enableRoomImage(f, true);
    await submitGeneration(f, invocationId, 'call-a');
    await submitGeneration(f, invocationId, 'call-b');
    await submitGeneration(f, invocationId, 'call-c');
    await expect(submitGeneration(f, invocationId, 'call-d')).rejects.toThrow(/quota/i);

    expect(generationRows(f)).toHaveLength(3);
    expect(taskRows(f)).toHaveLength(3);
    await expect.poll(() => f.providerCalls.length).toBe(3);
  });

  test('a running generation is not settled by reconciliation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await playgroundImageFixture({ beforeProvider: () => gate });
    const invocationId = releaseRoomInput(f, 'ask-gate');
    enableRoomImage(f, true);
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall(
            'execute',
            { action: 'call', tool: 'image_generate', input: { prompt: 'a quiet harbor' } },
            { id: 'call-gate' },
          ),
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('submitted'),
    ]);
    await runInvocation(f, invocationId);
    await expect.poll(() => generationRows(f)[0]?.status).toBe('running');

    // A reconciling pass (the startup path) must leave the task waiting: the
    // worker's finished listener settles it with the real result, and a task
    // settles exactly once.
    f.bridge.reconcile();
    expect(taskRows(f)[0]?.state).toBe('waiting');
    expect(receiptRows(f)).toEqual([]);

    release?.();
    const generationId = await settledGeneration(f);
    await settledTask(f);
    const receipt = receiptRows(f)[0];
    expect(receipt?.status).toBe('completed');
    const delivery = JSON.parse(String(receipt?.resultJson)) as { generation_id: string; outputs: unknown[] };
    expect(delivery.generation_id).toBe(generationId);
    expect(delivery.outputs).toHaveLength(1);
  });

  test('a standalone process never executes or recovers work of a host it does not serve', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-standalone-image-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeImageFixture(directory, configPath);
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    cleanups.push(() => store.close());
    const now = new Date().toISOString();
    store.orm
      .insert(chats)
      .values({
        id: 100n,
        hostKind: 'telegram',
        telegramChatId: 100n,
        canonicalChatId: 100n,
        type: 'private',
        updatedAt: now,
      })
      .run();
    store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
    store.orm
      .insert(chats)
      .values({
        id: 200n,
        hostKind: 'playground',
        telegramChatId: null,
        canonicalChatId: null,
        type: 'group',
        updatedAt: now,
      })
      .run();
    store.orm.insert(conversations).values({ id: 43n, chatId: 200n, createdAt: now, updatedAt: now }).run();

    const eligible = generationEligibilityForHosts(store, ['playground']);
    expect(eligible({ id: 'x', actorId: 'agent:42' })).toBe(false);
    expect(eligible({ id: 'x', actorId: 'agent:43' })).toBe(true);
    // An actor that is not one conversation's agent belongs to no host, and a
    // malformed actor id is not one either.
    expect(eligible({ id: 'x', actorId: 'admin:root' })).toBe(true);
    expect(eligible({ id: 'x', actorId: 'agent:0042' })).toBe(true);

    const calls: string[] = [];
    const providerFetch: typeof fetch = async (_input, init) => {
      calls.push(String(init?.body));
      return providerResponse(await providerPng());
    };
    const openService = () => {
      const service = createImageService(store, loaded.config, {
        providerAdapter: createOpenRouterAdapter({ fetchImpl: providerFetch }),
        executionEligibility: eligible,
      });
      cleanups.push(() => service.stop());
      return service;
    };
    const agentActor = (conversationId: bigint) => ({
      id: `agent:${conversationId.toString()}`,
      name: 'agent',
      source: 'agent' as const,
      scopes: [],
      privileged: true,
    });
    const input = (prompt: string) => ({
      authoredPrompt: prompt,
      modelId: 'gpt-image-1',
      aspectRatio: 'auto' as const,
      resolution: 'auto' as const,
      outputCount: 1,
      inputImages: [] as string[],
    });
    const service = openService();
    service.publishConfig(await service.prepareConfig(loaded.config, new SecretStore(keyJarPath(configPath))));
    const telegram = service.core.generations.create(input('telegram work'), agentActor(42n), 'tg-live');
    service.core.generations.create(input('playground work'), agentActor(43n), 'pg-live');

    // The room's generation runs; the Telegram one is never even claimed.
    await expect
      .poll(
        () =>
          store.orm
            .select()
            .from(imageGenerations)
            .all()
            .find((row) => row.id !== telegram.generation.id)?.status,
      )
      .toBe('succeeded');
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, telegram.generation.id)).get()?.status,
    ).toBe('queued');
    expect(
      store.orm
        .select()
        .from(imageGenerationAttempts)
        .where(eq(imageGenerationAttempts.generationId, telegram.generation.id))
        .all(),
    ).toEqual([]);
    expect(calls).toHaveLength(1);

    // A Telegram generation left running by a crash, and a fresh Playground one
    // queued while this process was stopping: a restart must recover the second
    // and leave the first exactly as it was.
    await service.stop();
    store.orm.run(sql`UPDATE image_generations SET status = 'running' WHERE id = ${telegram.generation.id}`);
    const crashQueued = service.core.generations.create(input('queued while stopping'), agentActor(42n), 'tg-queued');
    const restart = openService();
    restart.publishConfig(await restart.prepareConfig(loaded.config, new SecretStore(keyJarPath(configPath))));
    await restart.core.worker.stop();
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, telegram.generation.id)).get()?.status,
    ).toBe('running');
    expect(
      store.orm.select().from(imageGenerations).where(eq(imageGenerations.id, crashQueued.generation.id)).get()?.status,
    ).toBe('queued');
    expect(calls).toHaveLength(1);
  });

  test('message retention keeps the generation archive and an unhandled receipt', async () => {
    const f = await playgroundImageFixture();
    const published = releaseRoomInput(f, 'ask-retention');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, published, 'call-retention');
    await settledTask(f);
    await publishThroughReceipt(f, 'send-retention', { generationId });
    const mediaRows = f.store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    const assetId = mediaRows[0]!.localAssetId!;
    const assetPath = f.assets.resolve(assetId)!.path;

    // A second generation settles but its receipt is left unhandled.
    const pending = releaseRoomInput(f, 'ask-pending');
    await submitThroughRun(f, pending, 'call-pending');
    await expect.poll(() => taskRows(f).length).toBe(2);
    await expect.poll(() => receiptRows(f).some((row) => row.state === 'pending')).toBe(true);

    // A referenced asset survives a sweep and reaches the backup copy.
    await f.assets.sweep({ staleAfterMs: 0 });
    expect(f.assets.resolve(assetId)).not.toBeNull();
    const backup = await backupDatabase(f.config);
    const imagesRoot = join(f.config.data_dir, 'images');
    await expect(
      stat(join(backup.replace(/\.sqlite$/, '.images'), relative(imagesRoot, assetPath))),
    ).resolves.toBeDefined();

    // Retention removes the room's messages and media rows. The generation
    // archive, its audit and the unhandled receipt are never touched by it.
    purgeExpiredData(f.store.orm, f.config, new Date(Date.now() + 31 * 86_400_000));
    expect(roomMessages(f).filter((row) => row.messages.sentByBot)).toEqual([]);
    expect(f.store.orm.select().from(media).all()).toEqual([]);
    expect(generationRows(f)).toHaveLength(2);
    const outputs = f.bridge.sendableOutputs(generationId, f.room.conversationId);
    expect(outputs).toHaveLength(1);
    expect(f.bridge.assetContent(outputs![0]!.asset_id).bytes.byteLength).toBeGreaterThan(0);
    expect(receiptRows(f).some((row) => row.state === 'pending')).toBe(true);

    // The room's own copy is deleted only once nothing references it; the
    // archive original above stays readable.
    await f.assets.sweep({ staleAfterMs: 0 });
    expect(f.assets.resolve(assetId)).toBeNull();
    await expect(stat(assetPath)).rejects.toThrow();
    expect(f.bridge.assetContent(outputs![0]!.asset_id).bytes.byteLength).toBeGreaterThan(0);
  });

  test('a receipt queued behind a full concurrency never makes the scheduler spin', async () => {
    const f = await playgroundImageFixture({ maxConcurrency: 1 });
    enableRoomImage(f, true);

    // A second room occupies the only slot with a run held open by a gate.
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let blocked = false;
    const otherRoom = f.playground.createRoom({ title: 'Other', members: [{ name: 'Bob', role: 'admin' }] });
    const otherSubmitted = f.playground.submit(otherRoom.chatId, {
      requestKey: 'other-1',
      senderId: otherRoom.members[0]!.senderId,
      text: 'block the slot',
    });
    const otherRelease = f.playground.release(otherRoom.chatId, {
      releaseKey: 'other-1-release',
      revision: otherSubmitted.revision,
    });
    f.faux.setResponses([
      async () => {
        blocked = true;
        await gate;
        return fauxAssistantMessage('slot released');
      },
      () => fauxAssistantMessage('receipt handled'),
    ]);
    f.scheduler.start();
    f.scheduler.wake();
    await expect.poll(() => blocked).toBe(true);
    expect(
      f.store.orm.select().from(invocations).where(eq(invocations.id, otherRelease.invocationId!)).get()?.state,
    ).toBe('running');

    // The room's generation settles into a receipt while the slot is taken.
    await submitGeneration(f, null, 'call-busy');
    await settledGeneration(f);
    await settledTask(f);
    const [receiptInvocationId] = f.scheduler.processTasksDue();
    if (receiptInvocationId === undefined) {
      throw new Error('expected a receipt invocation');
    }
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, receiptInvocationId)).get()?.state).toBe(
      'queued',
    );
    // The queued receipt cannot launch, so the next wakeup must be the far
    // scheduler deadline, not the already-passed receipt deadline.
    expect(f.scheduler.nextDelayMilliseconds()).toBeGreaterThan(1_000);

    openGate?.();
    await expect
      .poll(
        () =>
          f.store.orm
            .select({ state: invocations.state })
            .from(invocations)
            .where(eq(invocations.id, receiptInvocationId))
            .get()?.state,
      )
      .not.toBe('queued');
    await f.scheduler.stop(0);
  });

  test('one tool call bills once; a conflicting replay of the same key is refused', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-replay');
    enableRoomImage(f, true);
    const first = await submitGeneration(f, invocationId, 'call-replay');
    const again = await submitGeneration(f, invocationId, 'call-replay');
    expect(again.generationId).toBe(first.generationId);
    expect(again.replayed).toBe(true);
    expect(generationRows(f)).toHaveLength(1);
    expect(taskRows(f)).toHaveLength(1);
    await settledGeneration(f);
    await expect.poll(() => f.providerCalls.length).toBe(1);

    // The same key with different content is a conflict, not a second bill.
    await expect(
      f.bridge.submit({
        conversationId: f.room.conversationId,
        invocationId,
        toolCallId: 'call-replay',
        authoredPrompt: 'something else entirely',
        modelId: undefined,
        aspectRatio: undefined,
        resolution: undefined,
        outputCount: undefined,
        inputMediaIds: [],
        extendedData: undefined,
      }),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(generationRows(f)).toHaveLength(1);
    expect(taskRows(f)).toHaveLength(1);
  });

  test('a foreign generation is never resolvable and the switch authorizes per conversation', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-foreign');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-foreign');

    expect(f.bridge.sendableOutputs(generationId, 999n)).toBeUndefined();
    expect(f.bridge.sendableOutputs('00000000-0000-4000-8000-000000000000', f.room.conversationId)).toBeUndefined();
    expect(f.bridge.enabledFor(999n)).toBe(false);
  });
});
