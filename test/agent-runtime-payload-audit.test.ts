import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { modelCalls } from '../src/store/schema.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './agent-runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('audits complete redacted model error details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-error-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
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
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'trigger a model error',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const errorDetail = 'Provider request failed with telegram-secret\nstatus=500\nbody={"error":"upstream exploded"}';
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: errorDetail })]);
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  await secrets.resolve(loaded.config.telegram.token);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets,
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
  });

  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'failed',
    reason: 'model_error',
  });
  expect(
    store.db
      .prepare<[], { state: string; error_code: string | null; error_detail: string | null }>(
        'SELECT state, error_code, error_detail FROM model_calls',
      )
      .get(),
  ).toEqual({
    state: 'error',
    error_code: 'model_error',
    error_detail: errorDetail.replace('telegram-secret', '[REDACTED]'),
  });
  store.close();
});

test.each([true, false])(
  'payload recording %s writes request/response only, never a replay snapshot',
  async (recordPayloads) => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-replay-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.developer = { record_model_payloads: recordPayloads };
        // One turn without a nudge: this test is about what a run records.
        config.agent!.send_nudge_enabled = false;
      }),
    );
    const loaded = await loadConfig(configPath);
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const configStore = await testConfigStore(loaded, fauxRegistry(faux));
    const store = await SqliteStore.open(loaded.config);
    // The migrated schema no longer carries the retired replay snapshot column,
    // so no recording mode has a place to write one.
    const columns = store.db
      .prepare<[], { name: string }>('PRAGMA table_info(model_calls)')
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain('replay_input_json');

    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 7,
        message: {
          message_id: 13,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hello',
        },
      },
      received,
    );
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected a due invocation');
    }

    faux.setResponses([
      (context, options) => {
        // The faux provider never touches the network, so the audit hooks are
        // triggered manually to mirror what real adapters do.
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        return fauxAssistantMessage('private assistant text');
      },
    ]);
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime({
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      }),
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      systemResources: emptySystemResources(),
    });
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });

    // Exactly one model call: no extra snapshot row, and nothing beyond the
    // opt-in request/response payload audit in either recording mode.
    const auditedCalls = store.orm.select().from(modelCalls).all();
    expect(auditedCalls).toHaveLength(1);
    const [call] = auditedCalls;
    expect(call?.state).toBe('success');
    expect(call?.finishedAt).not.toBeNull();
    if (recordPayloads) {
      expect(call?.requestJson).toContain('"messages"');
      expect(call?.responseJson).toBe('{"status":200}');
    } else {
      expect(call?.requestJson).toBeNull();
      expect(call?.responseJson).toBeNull();
    }
    store.close();
  },
);
