/**
 * Fixtures shared by the `test/playground/image*.test.ts` suites.
 *
 * The acceptance chain runs through the real assembly the composition root
 * uses — `createImageService`, `createImageBridge`, `loadPlugins(BUILTIN_PLUGINS)`,
 * `createHostTooling`, `createCoreRuntime`, `PlaygroundStore`, `PlaygroundIngress`,
 * `PlaygroundAssetStore` and the real system-skill tree. Only the image
 * provider's HTTP transport is a fake, and no Telegram transport exists at
 * all: a room picture can only come from the local asset store.
 *
 * Importing this module also registers the per-test teardown that closes every
 * fixture opened during the test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createOpenRouterAdapter } from '@surowan/image-service';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, expect } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createHostTooling, imageDeliveryResolver } from '../../src/adapters/local-monolith/host-tooling.ts';
import { createPlaygroundHost } from '../../src/adapters/local-monolith/playground/index.ts';

import {
  BUNDLED_SYSTEM_RESOURCES_DIR,
  FileSystemResources,
} from '../../src/adapters/local-monolith/system-resources.ts';
import { PlaygroundAssetStore } from '../../src/capabilities/media/local-assets.ts';
import { MediaService } from '../../src/capabilities/media/index.ts';
import { ContextBuilder } from '../../src/context/builder/index.ts';
import { ContextRefStore } from '../../src/context/refs.ts';
import { MemoryStore } from '../../src/context/memory.ts';
import { createImageBridge } from '../../src/image/bridge.ts';
import { createImageService } from '../../src/image/service.ts';
import { PlaygroundIngress } from '../../src/ingress/playground.ts';
import { createCoreRuntime } from '../../src/orchestration/runtime.ts';
import { KeyedSemaphore } from '../../src/platform/concurrency.ts';
import { unavailableCapabilities, type InvocationContext } from '../../src/platform/invocation-context.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import type { SystemSkill } from '../../src/platform/system-resources.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { loadPlugins } from '../../src/plugins/plugin.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { imageGenerations, longTasks, messages, messageRevisions, taskReceipts } from '../../src/store/schema/index.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from '../helpers.ts';
import { resolveConversation } from '../../src/adapters/local-monolith/runtime/support.ts';

export const directories: string[] = [];
export const cleanups: (() => Promise<void> | void)[] = [];

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
export async function providerPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 7, g: 8, b: 9 } } })
    .png()
    .toBuffer();
}

export function providerResponse(image: Buffer): Response {
  return new Response(
    JSON.stringify({ created: 0, data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] }),
    { status: 200 },
  );
}

export async function writeImageFixture(directory: string, configPath: string, maxConcurrency?: number): Promise<void> {
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

export interface FixtureOptions {
  /** Runs before the provider request; an unresolved promise holds the call. */
  readonly beforeProvider?: () => Promise<void> | undefined;
  /** Overrides the agent concurrency so a test can fill the only slot. */
  readonly maxConcurrency?: number;
  /** Runs while an input image is prepared, before its asset exists. */
  readonly beforeInputImage?: () => Promise<void> | void;
}

export async function playgroundImageFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-playground-image-'));
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
  // A room-only runtime: its task service serves the same host set.
  const tasks = new LongTaskService(store.orm, undefined, ['playground']);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => {
      await options.beforeInputImage?.();
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
    self: { displayName: 'Surowan' },
    pictures: assets,
    sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
  });
  const core = createCoreRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    hosts: { playground: host },
    conversation: (target) => resolveConversation(store, target),
    bot: { id: 999n, displayName: 'Surowan', username: null },
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

export type Fixture = Awaited<ReturnType<typeof playgroundImageFixture>>;

export const IMAGE_SKILL: SystemSkill = {
  name: 'image-generation',
  description: '',
  uri: 'system:///skills/image-generation/SKILL.md',
};

export function enableRoomImage(f: Fixture, enabled: boolean): void {
  f.playground.setImageEnabled(f.room.chatId, {
    enabled,
    actor: 'admin',
    revision: f.playground.room(f.room.chatId).revision,
  });
}

/** One held room input released into a queued invocation. */
export function releaseRoomInput(f: Fixture, requestKey: string): bigint {
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

export function runInvocation(f: Fixture, invocationId: bigint) {
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

export function capabilityToolNames(f: Fixture, invocationId: bigint): string[] {
  return f.tooling
    .capabilityTools(roomToolContext(f, invocationId), Date.now() + 60_000, unavailableCapabilities())
    .map((entry) => entry.tool.name)
    .sort();
}

/** The stable prompt the composition root would build for one room invocation. */
export function roomSystemPrompt(f: Fixture, invocationId: bigint): string {
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

export function generationRows(f: Fixture) {
  return f.store.orm.select().from(imageGenerations).all();
}

export function taskRows(f: Fixture) {
  return f.store.orm.select().from(longTasks).all();
}

export function receiptRows(f: Fixture) {
  return f.store.orm.select().from(taskReceipts).all();
}

/** Messages the bot published into the room (the inputs are not output). */
export function roomMessages(f: Fixture) {
  return f.store.orm
    .select()
    .from(messages)
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.currentRevisionId))
    .where(and(eq(messages.chatId, f.room.chatId), eq(messages.sentByBot, true)))
    .all();
}

export async function settledGeneration(f: Fixture): Promise<string> {
  await expect.poll(() => generationRows(f)[0]?.id).toBeDefined();
  const generationId = generationRows(f)[0]!.id;
  await expect.poll(() => generationRows(f)[0]?.status).toBe('succeeded');
  return generationId;
}

export async function settledTask(f: Fixture): Promise<void> {
  await expect.poll(() => taskRows(f)[0]?.state).toBe('completed');
}

export async function pendingReceiptInvocation(f: Fixture): Promise<bigint> {
  await expect.poll(() => receiptRows(f)[0]?.state).toBe('pending');
  const [invocationId] = f.scheduler.processTasksDue();
  if (invocationId === undefined) {
    throw new Error('expected a receipt invocation');
  }
  return invocationId;
}

/** Submits one generation for the room conversation at a fixed invocation id. */
export function submitGeneration(f: Fixture, invocationId: bigint | null, toolCallId: string) {
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
export async function submitThroughRun(f: Fixture, invocationId: bigint, callId: string): Promise<string> {
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
export async function publishThroughReceipt(
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
