import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { afterEach } from 'vitest';
import { ConversationContextStore } from '../../src/context/store.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { ConversationRuntime } from '../../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import {
  type FixtureConfig,
  fauxRegistry,
  testConfigJsonc,
  testConfigStore,
  testTelegramRuntime,
  writeTestConfig,
} from '../helpers.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];
const schedulers: BucketScheduler[] = [];
export const CHAT_ID = 123456789;

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop(0);
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

export async function fixture(transform?: (config: FixtureConfig) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-task-context-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent!.send_nudge_enabled = false;
      transform?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  const at = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, ?, ?, 'private', ?)",
    )
    .run(CHAT_ID, CHAT_ID, at);
  store.db
    .prepare('INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, ?, ?)')
    .run(at, at);
  const sends: string[] = [];
  const api: TelegramTransport = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: 900 + sends.length, date: 1_700_000_000, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => ({ message_id: 800, date: 1_700_000_000, chat: { id: CHAT_ID } }),
  };
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: () => 8 });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime(api),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    conversationRuntime,
  });
  const tasks = new LongTaskService(store.orm);
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  schedulers.push(scheduler);
  return {
    store,
    config: loaded.config,
    configStore,
    faux,
    tasks,
    scheduler,
    conversationRuntime,
    sends,
    api,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
  };
}

export function update(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function receipt(store: SqliteStore, taskId: bigint) {
  return store.db
    .prepare<
      [bigint],
      {
        state: string;
        invocation_id: bigint | null;
        invocation_outcome: string | null;
        completion_reason: string | null;
      }
    >('SELECT state, invocation_id, invocation_outcome, completion_reason FROM task_receipts WHERE task_id = ?')
    .get(taskId);
}

export function checkpointTexts(store: SqliteStore) {
  const contexts = new ConversationContextStore(store);
  const header = contexts.header(1n);
  if (header === undefined) {
    throw new Error('Expected a canonical context');
  }
  return contexts.retained(header).flatMap(({ seq, message }) =>
    message.role !== 'user'
      ? []
      : [
          {
            seq,
            text:
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n'),
          },
        ],
  );
}
