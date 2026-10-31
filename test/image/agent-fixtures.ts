import { noMemoReads } from '../../src/platform/invocation-context.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageConfigSnapshot, createOpenRouterAdapter, type ModelDefinition } from '@surowan/image-service';
import sharp from 'sharp';
import { afterEach, beforeEach, expect } from 'vitest';
import { createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { createImageBridge } from '../../src/image/bridge.ts';
import { createImageService } from '../../src/image/service.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import imagePlugin from '../../src/plugins/image/index.ts';
import type { ImagePluginBridge, InvocationScope } from '../../src/plugins/plugin.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { buckets, chats, conversations, invocations } from '../../src/store/schema/index.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from '../helpers.ts';

// Shared fixtures for the image-agent suites: temp-directory lifecycle, the
// bridge/service fixture, and helpers that drive and observe generations.

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

/** Registers the shared temp-directory lifecycle; call once at module top level. */
export function installImageAgentHooks(): void {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'surowan-image-agent-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
  });

  afterEach(async () => {
    // Stop workers before closing their borrowed database or removing its files.
    let failure: unknown;
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  });
}

export type ProviderCall = { headers: Record<string, string>; body: unknown };

export type ImageAgentFixture = {
  store: SqliteStore;
  service: ReturnType<typeof createImageService>;
  bridge: ReturnType<typeof createImageBridge>;
  pluginBridge: ImagePluginBridge;
  tasks: LongTaskService;
  calls: ProviderCall[];
};

/** Provider sink with a scripted failure plan: index i fails when plan[i] is true. */
function providerSink(calls: ProviderCall[], plan: readonly boolean[] = []): typeof fetch {
  return async (_input, init) => {
    const call: ProviderCall = {
      headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    if (plan[calls.length - 1] === true) {
      return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 });
    }
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    return new Response(
      JSON.stringify({ created: 0, data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] }),
      { status: 200 },
    );
  };
}

export async function fixture(plan: readonly boolean[] = []): Promise<ImageAgentFixture> {
  const calls: ProviderCall[] = [];
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
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
  await writeTestKeyJar(directory, { openrouter: 'sk-image-v1' });
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({ fetchImpl: providerSink(calls, plan) }),
  });
  cleanup.push(() => service.stop());
  const tasks = new LongTaskService(store.orm, () => undefined);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => {
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .png()
        .toBuffer();
      return { base64: png.toString('base64'), mime: 'image/png' };
    },
  });
  cleanup.push(() => bridge.stop());
  // Task rows reference real conversations; seed chat 100 / conversation 42
  // (and a second conversation 99 for the cross-conversation denial test).
  const now = new Date().toISOString();
  store.orm
    .insert(chats)
    .values({ id: 100n, telegramChatId: 100n, canonicalChatId: 100n, type: 'private', updatedAt: now })
    .run();
  store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
  store.orm
    .insert(conversations)
    .values({ id: 99n, chatId: 100n, messageThreadId: 99n, createdAt: now, updatedAt: now })
    .run();
  store.orm
    .insert(buckets)
    .values({
      id: 1n,
      conversationId: 42n,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  store.orm
    .insert(invocations)
    .values({
      id: 7n,
      bucketId: 1n,
      conversationId: 42n,
      state: 'completed',
      configHash: 'test',
      promptVersion: 1n,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  const loadedForStore = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: loadedForStore,
    modelSwitcher: new AgentModelSwitcher(loadedForStore),
    secrets: new SecretStore(keyJarPath(configPath)),
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, new SecretStore(keyJarPath(configPath))),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<typeof service.publishConfig>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  const pluginBridge: ImagePluginBridge = {
    enabled: () => bridge.enabled(),
    enabledFor: (conversationId) => bridge.enabledFor(conversationId),
    submit: (params, signal) => bridge.submit(params, signal),
    modelList: () => bridge.modelList(),
  };
  return { store, service, bridge, pluginBridge, tasks, calls };
}

export function generationIdOf(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>).generation_id;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

export async function waitFor<T>(check: () => T | null | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined) {
      return value as T;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

export async function submitFixtureWork(
  fixtureRef: ImageAgentFixture,
  options: { conversationId?: bigint; prompt?: string; outputCount?: number } = {},
): Promise<string> {
  const result = await fixtureRef.bridge.submit({
    conversationId: options.conversationId ?? 42n,
    invocationId: null,
    toolCallId: 'call-1',
    authoredPrompt: options.prompt ?? 'a quiet harbor at dusk',
    modelId: undefined,
    aspectRatio: undefined,
    resolution: undefined,
    outputCount: options.outputCount,
    inputMediaIds: [],
    extendedData: undefined,
  });
  return result.generationId;
}

export function fakeScope(
  bridge: ImagePluginBridge,
  resolveMedia: (ref: string) => bigint | undefined = () => undefined,
): InvocationScope {
  return {
    config: {} as InvocationScope['config'],
    context: {
      invocationId: 7n,
      conversationId: 42n,
      chatId: 100n,
      internalChatId: 100n,
      threadId: 0n,
      systemPrompt: '',
      userPrompt: '',
      directImages: [],
      visibleSenders: new Map(),
      callerUserId: 1n,
      completion: null,
      omittedNewMessages: 0,
      memoReads: noMemoReads,
    },
    deadline: Date.now() + 60_000,
    audit: {
      start: () => ({ succeed: () => undefined, fail: () => undefined }),
      reject: () => undefined,
    },
    tasks: new LongTaskService({} as never),
    resolveMedia,
    image: bridge,
  } as unknown as InvocationScope;
}

export function modelDirectoryFixture(fixtureRef: ImageAgentFixture) {
  const base = fixtureRef.service.core.config.current().models[0]!;
  const models: ModelDefinition[] = [
    { ...base, description: 'General images: write a natural-language visual description.' },
    {
      ...base,
      id: 'illustration',
      name: 'Illustration',
      description: 'Anime illustrations: use concise, comma-separated visual tags.',
      upstreamModel: 'example/illustration',
      providerTag: 'illustration-provider',
      credentialRef: 'illustration-key',
      capabilities: { ...base.capabilities, imageInput: false, maxInputImages: 0, maxOutputs: 1 },
    },
  ];
  const credentials = { openrouter: 'sk-image-v1', 'illustration-key': 'sk-illustration-fixture' };
  const publish = (next: readonly ModelDefinition[]) =>
    fixtureRef.service.publishConfig(createImageConfigSnapshot({ version: 'directory', models: next, credentials }));
  publish(models);
  const audit = createToolAudit(fixtureRef.store, 7n);
  const scope = { ...fakeScope(fixtureRef.pluginBridge), audit };
  const execute = createExecuteTool({ audit, capabilities: imagePlugin.capabilities?.(scope) ?? [] });
  return { models, publish, execute };
}
