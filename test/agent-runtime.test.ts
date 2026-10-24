import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { modelCalls } from '../src/store/schema.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './agent-runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('a fresh Agent drops assistant thinking when CoT recording is off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory));
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
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
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
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
      options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
      void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), {
        stopReason: 'toolUse',
      });
    },
    (context, options) => {
      options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
      void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
      // The model emits thinking regardless; the developer switch decides whether it persists.
      return fauxAssistantMessage([fauxThinking('should not persist'), fauxText('private assistant text')]);
    },
  ]);
  let messageId = 500;
  const api: TelegramTransport = {
    sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime(api),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(
    store.db
      .prepare<[], { text: string; thinking_text: string }>(
        "SELECT text, thinking_text FROM agent_messages WHERE role = 'assistant' ORDER BY sequence_no",
      )
      .all(),
  ).toEqual([
    { text: '', thinking_text: '' },
    { text: 'private assistant text', thinking_text: '' },
  ]);
  store.close();
});

test.each([undefined, false, true])(
  'a fresh Agent preserves auditing and hot-applies payload recording from %s',
  async (recordPayloads) => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.developer =
          recordPayloads === undefined
            ? { record_agent_thinking: true }
            : { record_model_payloads: recordPayloads, record_agent_thinking: true };
      }),
    );
    const loaded = await loadConfig(configPath);
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const configStore = await testConfigStore(loaded, fauxRegistry(faux));
    const store = await SqliteStore.open(loaded.config);
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
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
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update, received);
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
        // The faux provider never touches the network, so the snapshot hooks are
        // triggered manually to mirror what real adapters do.
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        // OpenAI-compatible endpoints reject a tool whose `parameters` is not a root
        // object schema; the top-level union `execute` used to carry failed every
        // gpt-4o invocation with 400 invalid_function_parameters.
        const tools = getCurrentTools(context.messages);
        expect(tools.map((tool) => tool.name)).toEqual(['read', 'send', 'send_reply', 'execute']);
        for (const tool of tools) {
          expect(tool.parameters).toMatchObject({ type: 'object' });
        }
        const current = configStore.current();
        configStore.publish({
          ...current,
          config: {
            ...current.config,
            developer: { record_model_payloads: !recordPayloads, record_agent_thinking: true },
          },
        });
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        return fauxAssistantMessage([fauxThinking('cot before the answer'), fauxText('private assistant text')]);
      },
    ]);
    let messageId = 500;
    const api: TelegramTransport = {
      sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    };
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime(api),
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      systemResources: emptySystemResources(),
    });
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(
      store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM host_sends WHERE state = 'success'").get()
        ?.count,
    ).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages WHERE sent_by_bot = 1').get()
        ?.count,
    ).toBe(1n);
    const assistantTexts = store.db
      .prepare<[], { text: string }>("SELECT text FROM agent_messages WHERE role = 'assistant' ORDER BY sequence_no")
      .all()
      .map((row) => row.text);
    expect(assistantTexts).toContain('private assistant text');
    expect(
      store.db
        .prepare<[], { text: string; thinking_text: string }>(
          "SELECT text, thinking_text FROM agent_messages WHERE role = 'assistant' AND thinking_text != ''",
        )
        .all(),
    ).toEqual([{ text: 'private assistant text', thinking_text: 'cot before the answer' }]);
    expect(
      store.db
        .prepare<[], { count: bigint }>(
          "SELECT COUNT(*) AS count FROM agent_messages WHERE role != 'assistant' AND thinking_text != ''",
        )
        .get()?.count,
    ).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'").get()
        ?.count,
    ).toBe(2n);
    const presented = store.db
      .prepare<[], { tools_json: string | null }>(
        "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    expect(presented?.tools_json).toBe(JSON.stringify(['read', 'send', 'send_reply', 'execute']));
    const snapshot = store.db
      .prepare<[], { request_json: string | null; response_json: string | null }>(
        "SELECT request_json, response_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    if (recordPayloads === true) {
      expect(String(snapshot?.request_json)).toContain('"messages"');
      expect(snapshot?.response_json).toBe(JSON.stringify({ status: 200 }));
    } else {
      expect(snapshot).toEqual({ request_json: null, response_json: null });
    }
    const nextCall = store.db
      .prepare<[], { request_json: string | null; response_json: string | null }>(
        'SELECT request_json, response_json FROM model_calls ORDER BY id DESC LIMIT 1',
      )
      .get();
    if (recordPayloads === true) {
      expect(nextCall).toEqual({ request_json: null, response_json: null });
    } else {
      expect(nextCall?.request_json).toContain('"messages"');
      expect(nextCall?.response_json).toBe('{"status":200}');
    }
    const auditedCalls = store.orm.select().from(modelCalls).all();
    // The replay snapshot path is retired: whichever recording mode is active,
    // the migrated schema has no column left to hold one.
    const callColumns = store.db
      .prepare<[], { name: string }>('PRAGMA table_info(model_calls)')
      .all()
      .map((column) => column.name);
    expect(callColumns).not.toContain('replay_input_json');
    for (const call of auditedCalls) {
      expect(call.outputTokens).toBeGreaterThan(0n);
      expect(call.totalTokens).toBe(
        call.inputTokens! + call.outputTokens! + call.cacheReadTokens! + call.cacheWriteTokens!,
      );
      expect(call.cost).toBe(0);
      expect(call.cacheReadTokens).toBeGreaterThanOrEqual(0n);
      expect(call.cacheWriteTokens).toBeGreaterThanOrEqual(0n);
      expect(call.finishedAt).not.toBeNull();
    }
    expect(
      store.db
        .prepare(
          "SELECT amount FROM daily_usage WHERE scope = 'chat' AND resource = '123456789' AND metric = 'model_tokens'",
        )
        .get(),
    ).toEqual({
      amount: auditedCalls.reduce((total, call) => total + call.totalTokens!, 0n),
    });
    const registryRow = store.db
      .prepare<[bigint], { tool_registry_json: string | null }>(
        'SELECT tool_registry_json FROM invocations WHERE id = ?',
      )
      .get(invocationId);
    expect(registryRow?.tool_registry_json).toContain('"name":"send"');
    expect(registryRow?.tool_registry_json).toContain('"label":"Send to Telegram"');
    expect(registryRow?.tool_registry_json).toContain('Publish exactly one warranted user-visible Telegram message');
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
        .get()?.count,
    ).toBe(0n);
    store.close();
  },
);
