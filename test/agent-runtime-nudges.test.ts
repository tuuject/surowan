import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
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
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './agent-runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('nudges the model once to use send when it drafts a private reply and never re-nudges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-nudge-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
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

  // Turn 1: a short would-be reply drafted as private assistant text, no send
  // call — shorter drafts must nudge too (regression: a 40-char threshold used
  // to swallow them). Turn 2: after the nudge, the model still forgets send —
  // proving no re-nudge.
  let sawNudge = false;
  faux.setResponses([
    fauxAssistantMessage('short private reply'),
    (context) => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const content = lastUser?.content;
      const nudgeText = Array.isArray(content) ? (content.find((block) => block.type === 'text')?.text ?? '') : '';
      if (nudgeText.includes('call the send tool')) {
        sawNudge = true;
      }
      return fauxAssistantMessage('still no send');
    },
  ]);
  const api: TelegramTransport = {
    sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime(api),
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(sawNudge).toBe(true);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(1n);
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count).toBe(0n);
  expect(faux.state.callCount).toBe(2);
  store.close();
});

test('does not nudge when the model ends without any draft text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-nudge-empty-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 5,
    message: {
      message_id: 11,
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

  // The model deliberately stays silent: no tool call and only blank drafts.
  faux.setResponses([fauxAssistantMessage('   ')]);
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
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(0n);
  expect(faux.state.callCount).toBe(1);
  store.close();
});

test('send_reply publishes its parts in order and counts as one send in the canonical history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.agent!.send_nudge_enabled = true;
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
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'how does it work?',
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
    fauxAssistantMessage(
      fauxToolCall('send_reply', {
        reply_to_message_id: '10',
        parts: [{ text: 'Short version first.' }, { text: 'Then the detail.' }],
      }),
      { stopReason: 'toolUse' },
    ),
    // Private wrap-up text: the send nudge must not fire after a send_reply.
    fauxAssistantMessage('done'),
  ]);
  const sent: { text: string; replyTo: number | undefined }[] = [];
  const api: TelegramTransport = {
    sendMessage: async (_chatId, text, options) => {
      sent.push({ text, replyTo: options.reply_parameters?.message_id });
      return { message_id: 500 + sent.length, date: 1_700_000_100, chat: { id: 123456789 } };
    },
    sendSticker: async () => ({ message_id: 600, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime(api),
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
  });
  try {
    expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });
    expect(sent).toEqual([
      { text: 'Short version first.', replyTo: 10 },
      { text: 'Then the detail.', replyTo: undefined },
    ]);
    expect(
      store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'agent'").get()
        ?.count,
    ).toBe(2n);
    const context = store.db
      .prepare<[], { send_count_total: bigint }>('SELECT send_count_total FROM conversation_contexts')
      .get();
    expect(context?.send_count_total).toBe(1n);
    const counted = store.db
      .prepare<[], { role: string; send_seq: bigint | null }>(
        'SELECT role, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all();
    expect(counted).toEqual([{ role: 'toolResult', send_seq: 1n }]);
  } finally {
    store.close();
  }
});
