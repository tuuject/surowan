import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, type MutableModels } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore, InvocationConfigSnapshot } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import type { TelegramHost } from '../src/adapters/local-monolith/telegram-host.ts';
import {
  fauxRegistry,
  sleep,
  testConfigJsonc,
  testConfigStore,
  testTelegramHost,
  testTelegramRuntime,
  writeTestConfig,
} from './helpers.ts';

const directories: string[] = [];

export const CHAT_ID = 123456789;
export const SEND_MESSAGE_ID = 900;

export async function cleanupFixtureDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly fileConfig: FileConfig;
  readonly conversationRuntime: ConversationRuntime;
  readonly ingestion: TelegramIngestion;
  readonly sendApi: TelegramTransport;
  readonly host: TelegramHost;
  readonly typingSignals: AbortSignal[];
  /** Builds a runtime over a fresh faux provider, mirroring the composition root. */
  runtimeWith(
    faux: ReturnType<typeof fauxProvider>,
    overrides?: { readonly systemPrompt?: string; readonly registryModelId?: string },
  ): Promise<AgentRuntime>;
  /** The same runtime plus the invocation snapshot that carries its config overrides. */
  runtimeAndSnapshot(
    faux: ReturnType<typeof fauxProvider>,
    overrides?: { readonly systemPrompt?: string; readonly registryModelId?: string },
  ): Promise<{ readonly runtime: AgentRuntime; readonly snapshot: InvocationConfigSnapshot }>;
}

export async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-hot-inject-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    // Zero-second windows keep the scheduler deterministic: a bucket is due the
    // moment its message lands, and the idle grace is the only thing that keeps
    // a run alive afterwards.
    config.telegram.bucket_window_seconds = 0;
    config.agent!.send_nudge_enabled = false;
    config.agent!.context!.idle_grace_seconds = 2;
    config.agent!.context!.max_wall_clock_seconds = 60;
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  // One faux registry shared by the fixture store and every runtime build: a
  // test stands its own faux provider into it through the mutable handle below.
  const registry = fauxRegistry(fauxAgent());
  const configStore = await testConfigStore(loaded, registry);
  const models = registry.models as MutableModels;
  const store = await SqliteStore.open(loaded.config);
  // Telegram hands out a new message ID per send; a repeated one would collide
  // with the bot message the previous send recorded.
  let nextMessageId = SEND_MESSAGE_ID;
  const typingSignals: AbortSignal[] = [];
  const sendApi: TelegramTransport = {
    sendTyping: async (_chatId, _threadId, signal) => {
      typingSignals.push(signal);
    },
    sendMessage: async () => ({ message_id: nextMessageId++, date: 1_700_000_100, chat: { id: CHAT_ID } }),
    sendSticker: async () => ({ message_id: nextMessageId++, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => loaded.config.agent!.context!.agent_cache_size,
  });
  // One host for the runtime and for the test, so a test drives the very same
  // activity map the runtime does.
  const host = testTelegramHost(sendApi);
  const { conversation } = testTelegramRuntime(sendApi);
  const build = async (
    faux: ReturnType<typeof fauxProvider>,
    overrides: { readonly systemPrompt?: string; readonly registryModelId?: string } = {},
  ): Promise<{ readonly runtime: AgentRuntime; readonly snapshot: InvocationConfigSnapshot }> => {
    models.setProvider(faux.provider);
    const config: RawConfig =
      overrides.systemPrompt === undefined
        ? loaded.config
        : { ...loaded.config, agent: { ...loaded.config.agent, system_prompt: overrides.systemPrompt } };
    const runtimeConfigStore =
      overrides.systemPrompt === undefined ? configStore : await testConfigStore({ ...loaded, config }, registry);
    const runtime = new AgentRuntime({
      store,
      configStore: runtimeConfigStore,
      secrets: new SecretStore(),
      hosts: { telegram: host },
      conversation,

      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      systemResources: emptySystemResources(),
      conversationRuntime,
    });
    return { runtime, snapshot: runtimeConfigStore.beginInvocation() };
  };
  return {
    store,
    config: loaded.config,
    configStore,
    fileConfig: loaded.fileConfig,
    conversationRuntime,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    sendApi,
    host,
    typingSignals,
    runtimeWith: async (faux, overrides = {}) => (await build(faux, overrides)).runtime,
    runtimeAndSnapshot: (faux, overrides = {}) => build(faux, overrides),
  };
}

export function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
}

export function update(updateId: number, messageId: number, text: string, threadId?: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
      date: 1_700_000_000 + messageId,
      chat:
        threadId === undefined
          ? { id: CHAT_ID, type: 'private', first_name: 'Owner' }
          : { id: CHAT_ID, type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

/** Polls until the condition holds, so timing-sensitive steps fail loudly. */
export async function until(condition: () => boolean, label: string, timeoutMilliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// The idle grace is off here: these tests care about the transcript, not about
// waiting for new buckets, and 0 keeps them fast and deterministic.
export const withoutIdleWait = (config: FileConfig): void => {
  config.agent!.context!.idle_grace_seconds = 0;
};
