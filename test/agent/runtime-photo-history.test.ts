import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  withoutInitialSystemMessage,
} from '@earendil-works/pi-ai';
import sharp from 'sharp';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { capability } from '../../src/capabilities/execute-tool.ts';
import { MediaService } from '../../src/capabilities/media/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { KeyedSemaphore } from '../../src/platform/concurrency.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from '../helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('keeps history photos as img_ refs for the multimodal agent while attaching only new photos', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-history-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const configStore = await testConfigStore(loaded, { models, visionModel: visionFaux.getModel() });
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));

  // First bucket: a photo message that becomes history for the next invocation.
  const firstReceived = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 10,
      message: {
        message_id: 40,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [
          { file_id: 'history-photo', file_unique_id: 'history-photo-unique', width: 16, height: 8, file_size: 100 },
        ],
      },
    },
    firstReceived,
  );
  const [firstInvocation] = scheduler.processDue(new Date(firstReceived.getTime() + 15_000));
  if (firstInvocation === undefined) {
    throw new Error('Expected the first invocation');
  }
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(firstInvocation);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);

  // Second bucket: text-only trigger; the earlier photo is history now.
  const secondReceived = new Date(firstReceived.getTime() + 60_000);
  ingestion.ingest(
    {
      update_id: 11,
      message: {
        message_id: 41,
        date: 1_700_000_060,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'what was in that picture?',
      },
    },
    secondReceived,
  );
  const [secondInvocation] = scheduler.processDue(new Date(secondReceived.getTime() + 15_000));
  if (secondInvocation === undefined) {
    throw new Error('Expected the second invocation');
  }

  let historyRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const user = withoutInitialSystemMessage(context.messages)[0];
      expect(user?.role).toBe('user');
      if (user?.role !== 'user' || typeof user.content === 'string') {
        throw new Error('Expected multimodal user content');
      }
      expect(user.content.filter((entry) => entry.type === 'image')).toHaveLength(0);
      const text = user.content.find((entry) => entry.type === 'text')?.text ?? '';
      expect(text).toContain('\n[40 ');
      expect(text).not.toContain(' figure_');
      const match = /\[photo (img_\S+)/.exec(text);
      historyRef = match?.[1];
      if (historyRef === undefined) {
        throw new Error('Multimodal agent context omitted the history img_ ref');
      }
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: historyRef } }),
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('understood'),
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  visionFaux.setResponses([fauxAssistantMessage('A dark rectangle.')]);
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe('history-photo');
        await copyFile(fixturePath, destination);
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    capabilityTools: (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
    ],
  });
  const outcome = await runtime.run(secondInvocation, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(agentFaux.state.callCount).toBe(3);
  expect(visionFaux.state.callCount).toBe(1);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});

test('lets a text-only agent read a Telegram photo through read_image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-fallback-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
      throw new Error('Expected custom agent provider fixture');
    }
    provider.models[0].input = ['text'];
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const visionModel = visionFaux.getModel();
  const configStore = await testConfigStore(loaded, { models, visionModel });
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 30,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 16, height: 8, file_size: 100 }],
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

  let photoRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const content = withoutInitialSystemMessage(context.messages)[0]?.content;
      if (typeof content !== 'string') {
        const text = content?.find((entry) => entry.type === 'text')?.text ?? '';
        const match = /\[photo (\S+)/.exec(text);
        photoRef = match?.[1];
      }
      if (photoRef === undefined) {
        throw new Error('Text-only agent context omitted image_ref');
      }
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: photoRef } }),
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('understood'),
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  visionFaux.setResponses([fauxAssistantMessage('A dark rectangle.')]);
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe('photo-file');
        await copyFile(fixturePath, destination);
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    capabilityTools: (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
    ],
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(agentFaux.state.callCount).toBe(3);
  expect(visionFaux.state.callCount).toBe(1);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  const presented = store.db
    .prepare<[], { tools_json: string | null }>(
      "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
    )
    .get();
  const toolsJson = presented?.tools_json ?? null;
  expect(toolsJson === null ? null : JSON.parse(toolsJson)).toEqual([
    'read',
    'search_memory',
    'read_memory',
    'send',
    'send_reply',
    'execute',
  ]);
  store.close();
});
