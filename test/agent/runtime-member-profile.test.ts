/**
 * `read_member_profile` as the runtime serves it: one primitive on every host,
 * with the avatar arriving at the model as real image content.
 *
 * The Telegram half runs the whole invocation, because the interesting claims
 * are end-to-end: the tool is in the request's registry, the avatar survives the
 * persisted history as an opaque reference, and the request the provider sees
 * carries the pixels. The room half checks the platform that has no profile
 * reader at all: the tool is still served and refuses as a tool error.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../../src/adapters/local-monolith/playground/index.ts';
import {
  createTelegramProfiles,
  type TelegramProfileApi,
} from '../../src/adapters/local-monolith/telegram/profiles.ts';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import { localImageAssets } from '../../src/capabilities/media/local-assets.ts';
import { ingestToolImage } from '../../src/capabilities/media/tool-image-store.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { identityConversation } from '../../src/platform/im-host/identity.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from '../helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

const CHAT_ID = 123456789;
// A Telegram private chat's id is the other person's user id.
const ALICE = CHAT_ID;

test('the avatar reaches the provider as an image and stays a reference on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-member-profile-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: CHAT_ID, instructions_file: 'chat-instructions.md' }];
      config.developer = { record_model_payloads: true };
    }),
  );
  const loaded = await loadConfig(configPath);
  const avatarPath = join(directory, 'avatar.png');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 8, b: 7 } } })
    .png()
    .toFile(avatarPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
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
        chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: ALICE, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'what do you remember about me?',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const api: TelegramProfileApi = {
    getChatMember: async () =>
      ({ status: 'member', user: { id: ALICE, is_bot: false, first_name: 'Alice', username: 'alice' } }) as never,
    getChat: async () => ({ id: CHAT_ID, type: 'private', first_name: 'Alice', bio: 'likes rocks' }) as never,
    getUserProfilePhotos: async () => ({
      total_count: 1,
      photos: [[{ file_id: 'avatar-large', file_unique_id: 'avatar-unique', width: 16, height: 16, file_size: 100 }]],
    }),
  };
  const download: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      const { copyFile } = await import('node:fs/promises');
      await copyFile(avatarPath, destination);
    },
  };
  const assets = localImageAssets(store.orm, loaded.config.data_dir);
  let providerSawImage = false;
  let toolResult: ToolResultMessage | undefined;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read_member_profile', { member: `uid:${ALICE}` }, { id: 'profile_call' }), {
      stopReason: 'toolUse',
    }),
    (context) => {
      const tools = getCurrentTools(context.messages).map((tool) => tool.name);
      expect(tools).toContain('read_member_profile');
      const result = context.messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === 'profile_call',
      );
      if (result?.role !== 'toolResult') {
        throw new Error('Missing profile result');
      }
      toolResult = result;
      providerSawImage = result.content.some((block) => block.type === 'image');
      return fauxAssistantMessage('');
    },
  ]);
  const telegramRuntime = testTelegramRuntime(
    {
      sendMessage: async () => {
        throw new Error('No sends in this test');
      },
      sendSticker: async () => {
        throw new Error('No sends in this test');
      },
    },
    { scope: 'private' },
  );
  const telegramHost = telegramRuntime.hosts.telegram;
  if (telegramHost === undefined) {
    throw new Error('Expected a Telegram host');
  }
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversation: telegramRuntime.conversation,
    hosts: {
      telegram: {
        ...telegramHost,
        profiles: () =>
          createTelegramProfiles({
            api,
            store,
            download,
            mediaCache: () => loaded.config.paths.media_cache,
          }),
      },
    },
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    toolImageStore: (chatId, bytes, signal) => ingestToolImage(assets, chatId, bytes, signal),
  });
  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  expect(providerSawImage).toBe(true);
  const text = toolResult?.content.find((block) => block.type === 'text');
  expect(text).toMatchObject({ type: 'text' });
  expect(JSON.parse(text?.type === 'text' ? text.text : '{}')).toMatchObject({
    display_name: 'Alice',
    bio: 'likes rocks',
    avatar: 'included below as an image',
  });
  // Persisted history keeps the reference, never the pixels.
  const stored = store.orm.all<{ payload_json: string }>(
    sql`SELECT payload_json FROM context_messages WHERE role = 'toolResult'`,
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.payload_json).toContain('toolImages');
  expect(stored[0]?.payload_json).not.toContain('iVBORw0KGgo');
  store.close();
});

test('a host without a profile reader still serves the tool and refuses clearly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-member-profile-none-'));
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
  const playground = new PlaygroundStore(store.orm);
  const room = playground.createRoom({ title: 'No Profiles', members: [{ name: 'Alice' }] });
  const alice = room.members[0];
  if (alice === undefined) {
    throw new Error('Expected a seeded room member');
  }
  playground.submit(room.chatId, { requestKey: 'req-1', senderId: alice.senderId, text: 'hello' });
  const release = playground.release(room.chatId, {
    releaseKey: 'rel-1',
    revision: playground.room(room.chatId).revision,
  });
  if (release.invocationId === null) {
    throw new Error('Expected a queued invocation');
  }
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read_member_profile', { member: `member:member_${alice.senderId}` }), {
      stopReason: 'toolUse',
    }),
    (context) => {
      const result = context.messages.find((message) => message.role === 'toolResult');
      if (result?.role !== 'toolResult') {
        throw new Error('Missing profile result');
      }
      expect(result.isError).toBe(true);
      return fauxAssistantMessage('');
    },
  ]);
  const runtime = new AgentRuntime({
    store,
    configStore: await testConfigStore(loaded),
    secrets: new SecretStore(),
    hosts: {
      playground: createPlaygroundHost({
        store,
        self: { displayName: 'Surowan' },
        sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      }),
    },
    conversation: (target) => identityConversation(target, 'playground', 'group'),
    bot: { id: 999n, displayName: 'Surowan', username: null },
    systemResources: emptySystemResources(),
  });
  expect(
    await runtime.run(release.invocationId, configStore.beginInvocation(), new AbortController().signal),
  ).toMatchObject({ state: 'completed' });
  store.close();
});
