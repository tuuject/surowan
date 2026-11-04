import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';

import {
  type FixtureConfig,
  fauxRegistry,
  testConfigJsonc,
  testConfigStore,
  testTelegramRuntime,
  writeTestConfig,
} from '../helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

interface SilentRun {
  readonly outcome: unknown;
  readonly sentTexts: readonly string[];
  readonly toolStates: readonly string[];
  readonly hostSends: bigint;
  readonly turnsUsed: bigint;
}

async function silentRun(name: string, responses: ReadonlyArray<ReadonlyArray<JsonObject>>): Promise<SilentRun> {
  const directory = await mkdtemp(join(tmpdir(), `surowan-agent-${name}-`));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config: FixtureConfig) => {
      config.agent!.send_empty_text_strategy = 'silent_success';
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  faux.setResponses([
    ...responses.map((calls) =>
      fauxAssistantMessage(
        calls.map((args) => fauxToolCall('send', args)),
        { stopReason: 'toolUse' },
      ),
    ),
    fauxAssistantMessage(''),
  ]);
  const sentTexts: string[] = [];
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
        return { message_id: sentTexts.length, date: 1, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
  });
  try {
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    const toolStates = store.db
      .prepare<[bigint], { state: string }>('SELECT state FROM tool_calls WHERE invocation_id = ? ORDER BY id')
      .all(invocationId)
      .map((row) => row.state);
    const hostSends =
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count ?? 0n;
    const turnsUsed =
      store.db
        .prepare<[bigint], { turns_used: bigint }>('SELECT turns_used FROM invocations WHERE id = ?')
        .get(invocationId)?.turns_used ?? 0n;
    return { outcome, sentTexts, toolStates, hostSends, turnsUsed };
  } finally {
    store.close();
  }
}

test('three silent empty-text sends in a row trip the circuit breaker', async () => {
  const run = await silentRun('silent-streak', [[{}], [{}], [{}], [{}]]);
  expect(run.outcome).toEqual({ state: 'completed', reason: 'silent_send' });
  expect(run.sentTexts).toEqual([]);
  expect(run.toolStates).toEqual(['success', 'success', 'success']);
  expect(run.hostSends).toBe(0n);
  expect(run.turnsUsed).toBe(3n);
});

test('a published message resets the consecutive silent count', async () => {
  const run = await silentRun('silent-reset', [[{}], [{ text: 'hi' }], [{}], [{}]]);
  expect(run.outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(run.sentTexts).toEqual(['hi']);
  expect(run.toolStates).toEqual(['success', 'success', 'success', 'success']);
  expect(run.hostSends).toBe(1n);
});
