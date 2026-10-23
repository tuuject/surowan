import { expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { AgentSettings, FileConfig, RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { eq } from 'drizzle-orm';
import { buckets, chatMigrations, invocations } from '../src/store/schema.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore, type InvocationConfigSnapshot } from '../src/platform/runtime-config.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { sleep, testConfigJsonc, testTelegramRuntime, type TestRegistry, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
export const CHAT_A = -100_000_000;
export const CHAT_B = -200_000_000;
export const CHAT_MIGRATED_FROM = -300_000_000;
export const CHAT_MIGRATED_TO = -300_000_001;
export const DEFAULT_MODEL = 'agent-model';
export const VISION_MODEL = 'agent-model-vision';
export const FORUM_TOPIC_ID = 7_000_000n;

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

/** One faux provider hosting both the default (text-only) and the vision model. */
export function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [
      { id: DEFAULT_MODEL, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
      { id: VISION_MODEL, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768, reasoning: true },
    ],
  });
}

export function textUpdate(
  chatId: number,
  updateId: number,
  messageId: number,
  text: string,
  threadId?: bigint,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: 'Group', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: Number(threadId), is_topic_message: true }),
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export interface ModelCallRow {
  readonly provider: string;
  readonly model: string;
  readonly state: string;
}

export function modelCalls(store: SqliteStore, invocationId: bigint): ModelCallRow[] {
  return store.db
    .prepare<[bigint], ModelCallRow>(
      "SELECT provider, model, state FROM model_calls WHERE invocation_id = ? AND role = 'agent' ORDER BY id",
    )
    .all(invocationId);
}

export interface ContextMessageRow {
  readonly context_id: bigint;
  readonly chat_id: bigint;
  readonly seq: bigint;
  readonly role: string;
  readonly payload_json: string;
}

export function contextMessagesByChat(store: SqliteStore): ContextMessageRow[] {
  return store.db
    .prepare<[], ContextMessageRow>(
      `SELECT cm.context_id, c.telegram_chat_id AS chat_id, cm.seq, cm.role, cm.payload_json
       FROM context_messages cm
       JOIN conversation_contexts cc ON cc.id = cm.context_id
       JOIN conversations v ON v.id = cc.conversation_id
       JOIN chats c ON c.id = v.chat_id
       ORDER BY cm.context_id, cm.seq`,
    )
    .all();
}

export function contextIds(store: SqliteStore): { context_id: bigint; chat_id: bigint }[] {
  return store.db
    .prepare<[], { context_id: bigint; chat_id: bigint }>(
      `SELECT cc.id AS context_id, c.telegram_chat_id AS chat_id
       FROM conversation_contexts cc
       JOIN conversations v ON v.id = cc.conversation_id
       JOIN chats c ON c.id = v.chat_id
       ORDER BY cc.id`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly registry: TestRegistry;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly sends: string[];
  runtimeWith(
    faux: ReturnType<typeof fauxProvider>,
    config?: RawConfig,
  ): { readonly runtime: AgentRuntime; readonly registry: TestRegistry };
}

export async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-chat-model-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config: FileConfig) => {
    config.telegram.bucket_window_seconds = 0;
    config.agent!.send_nudge_enabled = false;
    config.agent!.context!.idle_grace_seconds = 0;
    // Add the vision model to the provider definition so validation passes.
    const agentProvider = config.providers.agent;
    if (agentProvider === undefined || agentProvider.kind !== 'custom') {
      throw new Error('fixture needs custom agent provider');
    }
    agentProvider.models.push({
      id: VISION_MODEL,
      name: 'Vision Model',
      reasoning: true,
      compat: { supports_developer_role: false },
      input: ['text', 'image'],
      context_window: 200_000,
      max_tokens: 32_768,
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    });
    // Chat A: overrides provider + model + thinking.
    // Chat B: inherits global defaults.
    // CHAT_MIGRATED_FROM: an entry for a chat that was migrated away.
    config.telegram.chats = [
      {
        id: CHAT_A,
        instructions_file: 'chat-instructions.md',
        provider: 'agent',
        model: VISION_MODEL,
        thinking_level: 'high',
      },
      {
        id: CHAT_B,
        instructions_file: 'chat-instructions.md',
      },
      {
        id: CHAT_MIGRATED_FROM,
        instructions_file: 'chat-instructions.md',
        provider: 'agent',
        model: VISION_MODEL,
        thinking_level: 'high',
      },
    ];
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  // Insert a migration: messages for CHAT_MIGRATED_TO resolve to CHAT_MIGRATED_FROM.
  store.orm
    .insert(chatMigrations)
    .values({
      oldChatId: BigInt(CHAT_MIGRATED_FROM),
      newChatId: BigInt(CHAT_MIGRATED_TO),
      receivedAt: new Date().toISOString(),
    })
    .run();
  const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const sends: string[] = [];
  let messageId = 900;
  const sendApi: TelegramTransport = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_A } };
    },
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_A } }),
  };
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => loaded.config.agent!.context!.agent_cache_size,
  });
  return {
    store,
    config: loaded.config,
    configStore,
    registry,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    sends,
    runtimeWith: (faux, config = loaded.config) => {
      const models = createModels();
      models.setProvider(faux.provider);
      const fauxModels: TestRegistry = { models, visionModel: faux.getModel() };
      const runtimeStore = new RuntimeConfigurationStore({ config, hash: 'runtime', ...fauxModels });
      return {
        runtime: new AgentRuntime({
          store,
          configStore: runtimeStore,
          secrets: new SecretStore(),
          ...testTelegramRuntime(sendApi),
          bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
          systemResources: emptySystemResources(),
          conversationRuntime,
        }),
        registry: fauxModels,
      };
    },
  };
}

export function snapshotOf(config: RawConfig, registry: TestRegistry, hash = 'snapshot'): InvocationConfigSnapshot {
  return new RuntimeConfigurationStore({ config, hash, ...registry }).beginInvocation();
}

export function withChat(base: RawConfig, chatId: number, patch: Partial<AgentSettings>): RawConfig {
  return {
    ...base,
    telegram: {
      ...base.telegram,
      chats: base.telegram.chats.map((chat) => (chat.id === chatId ? { ...chat, ...patch } : chat)),
    },
  };
}

export async function runOnce(
  fixture: Fixture,
  runtime: AgentRuntime,
  snapshot: InvocationConfigSnapshot,
  chatId: number,
  updateId: number,
  messageId: number,
  text: string,
  threadId?: bigint,
): Promise<bigint> {
  fixture.ingestion.ingest(textUpdate(chatId, updateId, messageId, text, threadId), new Date());
  const [invocationId] = fixture.scheduler.processDue(new Date());
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const outcome = await runtime.run(invocationId, snapshot, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  const invocation = fixture.store.orm
    .update(invocations)
    .set({ state: 'completed' })
    .where(eq(invocations.id, invocationId))
    .returning({ bucketId: invocations.bucketId })
    .get();
  if (invocation !== undefined) {
    fixture.store.orm.update(buckets).set({ state: 'completed' }).where(eq(buckets.id, invocation.bucketId)).run();
  }
  return invocationId;
}

export async function waitForInvocation(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for invocation');
}
