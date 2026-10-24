import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { expect } from 'vitest';
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
import type { ToolFactory } from '../src/orchestration/agent-runtime-types.ts';

const cleanups: (() => Promise<void>)[] = [];

/** Removes every directory and closes every store created by `fixture` since the last cleanup. */
export async function cleanupFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}

export async function fixture(transform?: (config: FileConfig) => void, additionalTools?: ToolFactory) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-task-hot-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent!.send_nudge_enabled = false;
      config.agent!.send_barrier_enabled = true;
      config.agent!.context!.retained_sends_target = 20;
      config.agent!.context!.retained_sends_max = 30;
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
  cleanups.push(async () => {
    store.close();
  });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  ingestion.ingest(update(1, 'ordinary Alice request'));
  const tasks = new LongTaskService(store.orm);
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: () => 8 });
  const sends: string[] = [];
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversationRuntime,
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    ...testTelegramRuntime({
      sendMessage: async (_chatId, text) => {
        sends.push(text);
        return { message_id: 900 + sends.length, date: 1_700_000_000, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 800, date: 1_700_000_000, chat: { id: 123456789 } }),
    }),
    ...(additionalTools === undefined ? {} : { additionalTools }),
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  cleanups.push(() => scheduler.stop(0));
  return { store, configStore, faux, tasks, scheduler, conversationRuntime, sends, ingestion };
}

export function update(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function receipts(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        task_id: bigint;
        bucket_id: bigint;
        invocation_id: bigint;
        state: string;
        invocation_outcome: string | null;
        completion_reason: string | null;
      }
    >(
      'SELECT task_id, bucket_id, invocation_id, state, invocation_outcome, completion_reason FROM task_receipts ORDER BY task_id',
    )
    .all();
}

export function checkpoints(store: SqliteStore) {
  const contexts = new ConversationContextStore(store);
  const header = contexts.header(1n)!;
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

export function complete(f: Awaited<ReturnType<typeof fixture>>, name: string, bypassDailyBudget = false) {
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({
    payload: { name },
    delivery: {
      bypassDailyBudget,
      mentionUser: { userId: name === 'Alice' ? 42n : 43n, displayName: name },
    },
  });
  scope.complete(task.taskId, { result: `${name}-result` });
  return task.taskId;
}

export const send = (text: string) =>
  fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text }), { stopReason: 'toolUse' });

export async function finished(f: Awaited<ReturnType<typeof fixture>>, count: bigint) {
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocations WHERE state NOT IN ('running', 'queued')",
          )
          .get()?.count,
    )
    .toBe(count);
}
