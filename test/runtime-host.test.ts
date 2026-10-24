import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createCoreRuntime } from '../src/orchestration/runtime.ts';
import { listConversationContexts } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { assembleRawConfig } from '../src/platform/config.ts';
import { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { resolveSystemResource, type SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import * as schema from '../src/store/schema.ts';
import { fauxRegistry, testConfigJsonc, testTelegramRuntime } from './helpers.ts';
import { validateFileConfig } from '../src/platform/config-validate.ts';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('core assembly uses injected resources without loading host files or starting lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-runtime-host-'));
  directories.push(directory);
  const { fileConfig } = validateFileConfig(JSON.parse(testConfigJsonc(directory)));
  const config = assembleRawConfig(fileConfig, 'in-memory system prompt', new Map());
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = new RuntimeConfigurationStore({
    config,
    hash: 'in-memory',
    ...fauxRegistry(faux),
  });
  const store = await SqliteStore.open(config);
  let core: ReturnType<typeof createCoreRuntime> | undefined;
  let conversationId: bigint | undefined;
  try {
    const reads: string[] = [];
    const resources: SystemResources = {
      skills: [{ name: 'memory', description: 'In-memory skill', uri: 'system:///skills/memory/SKILL.md' }],
      resolve: resolveSystemResource,
      async readText(reference, base) {
        const { uri } = resolveSystemResource(reference, base);
        reads.push(uri);
        return { uri, text: 'injected resource content', truncated: false };
      },
    };
    const sends: string[] = [];
    core = createCoreRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime({
        sendMessage: async (_chatId, text) => {
          sends.push(String(text));
          return { message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } };
        },
        sendSticker: async () => ({ message_id: 502, date: 1_700_000_100, chat: { id: 123456789 } }),
      }),
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
      systemResources: resources,
    });
    // Assembly must not start the scheduler or process anything on construction.
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
    expect(core).toHaveProperty('conversationRuntime');
    expect(core).toHaveProperty('scheduler');
    expect(core).toHaveProperty('runtime');
    expect(core).toHaveProperty('tasks');

    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-08-15T00:00:00.000Z');
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello',
      },
    };
    ingestion.ingest(update, received);
    conversationId = store.orm.select().from(schema.conversations).get()?.id;
    if (conversationId === undefined) {
      throw new Error('ingestion did not create a conversation');
    }
    const [invocationId] = core.scheduler.processDue(new Date(received.getTime() + 15_000));
    expect(invocationId).toBeDefined();
    if (invocationId === undefined) {
      throw new Error('Expected due invocation');
    }
    faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall('read', { uri: 'system:///skills/memory/SKILL.md' }), {
          stopReason: 'toolUse',
        }),
      () =>
        fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'read completed' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('done'),
    ]);
    const outcome = await core.runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(reads).toEqual(['system:///skills/memory/SKILL.md']);
    expect(sends).toEqual(['read completed']);
    expect(store.orm.select().from(schema.toolCalls).all()).toHaveLength(2);
    expect(listConversationContexts(store, { conversationId })).toEqual([
      expect.objectContaining({ conversationId, sendCountTotal: 1n }),
    ]);
  } finally {
    if (conversationId !== undefined) {
      core?.conversationRuntime.cachedAgent(conversationId)?.agent.abort();
      core?.conversationRuntime.forget(conversationId);
    }
    store.close();
  }
});
