import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type JsonObject,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import alarmPlugin from '../src/plugins/alarm/index.ts';
import type { ListAlarmToolDetails } from '../src/plugins/alarm/alarm.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { FileConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';

export const directories: string[] = [];
export const stores: SqliteStore[] = [];
export const schedulers: BucketScheduler[] = [];
export const CHAT_ID = 123456789;

// Failures must not leave a scheduler accessing a closed database or a locked temp directory.
export async function cleanupAlarmFixtures(): Promise<void> {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop(0);
  }
  for (const store of stores.splice(0)) {
    if (store.db.open) {
      store.close();
    }
  }
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export function update(id: number, text: string, userId = 42): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: userId === 42 ? 'Alice' : 'Bob' },
      text,
    },
  };
}

export function retainedMessages(store: SqliteStore): AgentMessage[] {
  const contexts = new ConversationContextStore(store);
  return contexts.retained(contexts.header(1n)!).map(({ message }) => message);
}

export function executeResults(messages: readonly AgentMessage[], tool: string): ToolResultMessage[] {
  return (
    messages
      .filter(
        (message): message is ToolResultMessage =>
          message.role === 'toolResult' &&
          message.toolName === 'execute' &&
          !message.isError &&
          typeof message.details === 'object' &&
          message.details !== null &&
          'tool' in message.details &&
          message.details.tool === tool,
      )
      // pi 1.x attaches run-scoped metadata (`durationMs`, `usage`) to live
      // transcript results; the canonical history does not persist them.
      .map(({ durationMs: _durationMs, usage: _usage, ...result }) => result)
  );
}

export function resultText(message: ToolResultMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function listItems(messages: readonly AgentMessage[]): ListAlarmToolDetails['items'] {
  const result = executeResults(messages, 'list_alarm').at(-1);
  if (result === undefined) {
    throw new Error('No successful list_alarm result in the model-visible history');
  }
  return (JSON.parse(JSON.parse(resultText(result)).text) as ListAlarmToolDetails).items;
}

export function call(tool: string, input: JsonObject = {}) {
  return fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool, input }), { stopReason: 'toolUse' });
}

export function send(text: string) {
  return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text }), { stopReason: 'toolUse' });
}

export function toolCallAudits(store: SqliteStore) {
  return store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
}

export function futureIso(offsetMs = 86_400_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export async function runtimeFixture(transform?: (config: FileConfig) => void, existingDirectory?: string) {
  const directory = existingDirectory ?? (await mkdtemp(join(tmpdir(), 'plasticwan-alarm-ctx-')));
  const configPath = join(directory, 'config.jsonc');
  if (existingDirectory === undefined) {
    directories.push(directory);
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
        config.agent!.send_nudge_enabled = false;
        transform?.(config);
      }),
    );
  }
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  if (existingDirectory === undefined) {
    const at = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, ?, ?, 'private', ?)",
      )
      .run(CHAT_ID, CHAT_ID, at);
    store.db
      .prepare(
        'INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, ?, ?)',
      )
      .run(at, at);
  }
  const sends: string[] = [];
  const tasks = new LongTaskService(store.orm);
  const plugins = loadPlugins([alarmPlugin]);
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => loaded.config.agent!.context!.agent_cache_size,
  });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async (_chatId, text) => {
        sends.push(text);
        return { message_id: 900 + sends.length, date: 1_700_000_000, chat: { id: CHAT_ID } };
      },
      sendSticker: async () => ({ message_id: 800, date: 1_700_000_000, chat: { id: CHAT_ID } }),
    }),
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
    conversationRuntime,
    capabilityTools: (context, deadline) => plugins.capabilities(store, loaded.config, context, deadline, tasks),
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  schedulers.push(scheduler);
  scheduler.start();
  return {
    store,
    config: loaded.config,
    configStore,
    faux,
    tasks,
    scheduler,
    conversationRuntime,
    sends,
    directory,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
  };
}

export async function runBatch(f: Awaited<ReturnType<typeof runtimeFixture>>, id: number, text: string, userId = 42) {
  const previous = f.store.db
    .prepare<[], { id: bigint }>('SELECT COALESCE(MAX(id), 0) AS id FROM invocations')
    .get()!.id;
  f.ingestion.ingest(update(id, text, userId));
  f.scheduler.wake();
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { id: bigint; state: string; completion_reason: string }>(
            'SELECT id, state, completion_reason FROM invocations ORDER BY id DESC LIMIT 1',
          )
          .get(),
      { timeout: 5_000, interval: 10 },
    )
    .toEqual({
      id: previous + 1n,
      state: 'completed',
      completion_reason: 'completed',
    });
  return previous + 1n;
}
