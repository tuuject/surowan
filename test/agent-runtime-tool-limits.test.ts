import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import Type from 'typebox';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './agent-runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('an invocation keeps running past the removed per-invocation tool-call cap and still audits the count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-no-tool-cap-'));
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
  const update: Update = {
    update_id: 3,
    message: {
      message_id: 12,
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

  const noop: AgentTool = {
    name: 'noop',
    label: 'Noop',
    description: 'Test-only tool that returns without side effects.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
  // 6 tool turns x 3 calls = 18 tool calls: the former max_tool_calls cap of 12
  // is gone, so only the per-injection turn budget (8) bounds the run. That
  // budget stops the run at the 8th turn, which is what 'turn_budget' records.
  faux.setResponses([
    ...Array.from({ length: 6 }, () =>
      fauxAssistantMessage([fauxToolCall('noop', {}), fauxToolCall('noop', {}), fauxToolCall('noop', {})], {
        stopReason: 'toolUse',
      }),
    ),
    fauxAssistantMessage('done'),
    fauxAssistantMessage(''),
  ]);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
    additionalTools: () => [noop],
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'turn_budget' });
  const audited = store.db
    .prepare<[bigint], { tool_calls_used: bigint }>('SELECT tool_calls_used FROM invocations WHERE id = ?')
    .get(invocationId);
  expect(audited?.tool_calls_used).toBe(18n);
  store.close();
});

test('counts tool descriptions in registry limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-tool-budget-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    // The id must match `agent.model`: the registry is validated against the
    // model the run's configuration snapshot names.
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 1_000, maxTokens: 100 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
  });
  const oversizedDescriptionTool: AgentTool = {
    name: 'large_description',
    label: 'Large description',
    description: 'x'.repeat(500),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };

  expect(() => runtime.validateAdditionalTools(previewContext(), [oversizedDescriptionTool], faux.getModel())).toThrow(
    'Tool registry exceeds 10%',
  );
  store.close();
});

test('a model that declares minimal tool-schema keywords is sent reduced tool definitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-tool-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider fixture');
      }
      const model = provider.models[0];
      if (model === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      model.tool_schema_keywords = 'minimal';
      config.developer = { record_model_payloads: true };
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
    update_id: 6,
    message: {
      message_id: 12,
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

  let presented: { name: string; parameters: unknown }[] = [];
  faux.setResponses([
    (context, options) => {
      // The faux provider never touches the network, so the snapshot hooks are
      // triggered manually to mirror what real adapters do.
      options?.onPayload?.(
        { model: 'agent-model', messages: context.messages, tools: getCurrentTools(context.messages) },
        faux.getModel(),
      );
      void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
      presented = getCurrentTools(context.messages).map((tool) => ({ name: tool.name, parameters: tool.parameters }));
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('private assistant text'),
  ]);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });

  // What the provider was handed: the shape of every call survives, the
  // validation-only annotations a grammar endpoint rejects are gone.
  expect(presented.map((tool) => tool.name)).toEqual(['read', 'send', 'send_reply', 'execute']);
  expect(JSON.stringify(presented)).not.toContain('minLength');
  expect(JSON.stringify(presented)).not.toContain('maxLength');
  expect(JSON.stringify(presented)).not.toContain('patternProperties');
  expect(presented.find((tool) => tool.name === 'read')?.parameters).toMatchObject({
    type: 'object',
    required: ['uri'],
    properties: { uri: { type: 'string' } },
  });

  // The audit records the reduced schema too: the registry hash is taken over the
  // definitions the model was handed.
  const registryRow = store.db
    .prepare<[bigint], { tool_registry_json: string | null }>('SELECT tool_registry_json FROM invocations WHERE id = ?')
    .get(invocationId);
  expect(registryRow?.tool_registry_json).toContain('"name":"read"');
  expect(registryRow?.tool_registry_json).not.toContain('minLength');
  const snapshot = store.db
    .prepare<[], { request_json: string | null }>(
      "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get();
  expect(snapshot?.request_json).not.toContain('minLength');
  store.close();
});
