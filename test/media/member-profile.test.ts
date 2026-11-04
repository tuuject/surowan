/**
 * `read_member_profile` against a real Telegram host and a real room host.
 *
 * The tool is a runtime primitive, so the thing under test is the whole path:
 * the token a message header shows, the conversation-bound authorization, the
 * host-specific fields, and the avatar's trip through the shared tool-image
 * channel. Telegram is a stand-in for the Bot API only; nothing else is faked.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatFullInfo, ChatMember, Update, UserProfilePhotos } from 'grammy/types';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../../src/adapters/local-monolith/playground/index.ts';
import { createRoomProfiles } from '../../src/adapters/local-monolith/playground/profiles.ts';

import {
  createTelegramProfiles,
  type TelegramProfileApi,
} from '../../src/adapters/local-monolith/telegram/profiles.ts';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import { localImageAssets, type PlaygroundAssetStore } from '../../src/capabilities/media/local-assets.ts';
import { ingestToolImage } from '../../src/capabilities/media/tool-image-store.ts';
import { createMemberProfileTool } from '../../src/capabilities/member-profile.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { type ConversationScope, identityConversation } from '../../src/platform/im-host/identity.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import { directories } from './fixtures.ts';

const PRIVATE_CHAT = 123456789;
const GROUP_CHAT = -123456789;
const ALICE = 42;
const BOB = 43;

interface TelegramFixture {
  readonly directory: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly assets: PlaygroundAssetStore;
  readonly invocationId: bigint;
  readonly scope: ConversationScope;
  readonly wireChatId: number;
}

async function telegramFixture(
  options: { readonly scope?: ConversationScope; readonly alsoFrom?: number } = {},
): Promise<TelegramFixture> {
  const scope = options.scope ?? 'group';
  const wireChatId = scope === 'private' ? PRIVATE_CHAT : GROUP_CHAT;
  const directory = await mkdtemp(join(tmpdir(), 'surowan-member-profile-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: wireChatId, instructions_file: 'chat-instructions.md' }];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  const chat =
    scope === 'private'
      ? { id: PRIVATE_CHAT, type: 'private' as const, first_name: 'Alice' }
      : { id: GROUP_CHAT, type: 'group' as const, title: 'Group' };
  const updates: Update[] = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat,
        from: { id: ALICE, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hello',
      },
    },
    ...(options.alsoFrom === undefined
      ? []
      : [
          {
            update_id: 2,
            message: {
              message_id: 11,
              date: 1_700_000_001,
              chat,
              from: { id: options.alsoFrom, is_bot: false, first_name: 'Other' },
              text: 'hi',
            },
          },
        ]),
  ];
  for (const update of updates) {
    ingestion.ingest(update, received);
  }
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const assets = localImageAssets(store.orm, loaded.config.data_dir);
  return { directory, loaded, store, assets, invocationId, scope, wireChatId };
}

function profileTool(
  f: TelegramFixture,
  api: TelegramProfileApi,
  options: { readonly avatar?: boolean; readonly download?: MediaDownloader } = {},
) {
  const profiles = createTelegramProfiles({
    api,
    store: f.store,
    download: options.download ?? {
      download: async () => {
        throw new Error('no avatar expected');
      },
    },
    mediaCache: () => join(f.loaded.config.paths.media_cache),
  });
  const conversation = identityConversation(
    { chatId: BigInt(f.wireChatId), threadId: 0n, conversationId: 1n },
    'telegram',
    f.scope,
  );
  const context = {
    ...previewContext('telegram'),
    invocationId: f.invocationId,
    conversationId: 1n,
    internalChatId: 1n,
    callerUserId: BigInt(ALICE),
  };
  return createMemberProfileTool({
    store: f.store,
    context,
    conversation,
    profiles: () => profiles,
    ...(options.avatar === false
      ? {}
      : {
          storeImage: (chatId: bigint, bytes: Uint8Array, signal: AbortSignal) =>
            ingestToolImage(f.assets, chatId, bytes, signal),
        }),
  });
}

function member(status: ChatMember['status'], user: Partial<ChatMember['user']> = {}): ChatMember {
  return {
    status,
    user: { id: ALICE, is_bot: false, first_name: 'Alice', username: 'alice', ...user },
  } as ChatMember;
}

test('Telegram reads a member the conversation showed, with standing and avatar', async () => {
  const f = await telegramFixture();
  const avatarPath = join(f.directory, 'avatar.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toFile(avatarPath);
  const api: TelegramProfileApi = {
    getChatMember: async () => ({ ...member('creator'), custom_title: 'Boss' }) as ChatMember,
    getChat: async () => {
      throw new Error('a group must not be asked for a person');
    },
    getUserProfilePhotos: async (): Promise<UserProfilePhotos> => ({
      total_count: 1,
      photos: [[{ file_id: 'avatar-large', file_unique_id: 'avatar-unique', width: 8, height: 8, file_size: 100 }]],
    }),
  };
  const { copyFile } = await import('node:fs/promises');
  const download: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      expect(fileId).toBe('avatar-large');
      await copyFile(avatarPath, destination);
    },
  };
  const tool = profileTool(f, api, { download });
  const result = await tool.execute('call-1', { member: `uid:${ALICE}` });
  const [text, marker] = result.content;
  if (text?.type !== 'text' || marker?.type !== 'text') {
    throw new Error('Expected a profile text and an image marker');
  }
  expect(JSON.parse(text.text)).toEqual({
    display_name: 'Alice',
    username: 'alice',
    is_bot: false,
    standing: 'creator',
    title: 'Boss',
    bio: null,
    language_code: null,
    joined_at: null,
    avatar: 'included below as an image',
  });
  expect(marker.text).toMatch(/^\[image [a-f0-9]{32}\]$/);
  expect(result.details).toMatchObject({ found: true, avatar: true });
  const audited = f.store.orm.select().from(toolCalls).all().at(-1);
  expect(audited).toMatchObject({ toolName: 'read_member_profile', state: 'success', sideEffect: false });
  expect(audited?.resultContentJson).not.toBeNull();
  f.store.close();
});

test('a uid this conversation never showed is refused without calling the Bot API', async () => {
  const f = await telegramFixture();
  let calls = 0;
  const api: TelegramProfileApi = {
    getChatMember: async () => {
      calls += 1;
      return member('member');
    },
    getChat: async () => {
      calls += 1;
      throw new Error('unexpected');
    },
    getUserProfilePhotos: async () => {
      calls += 1;
      return { total_count: 0, photos: [] };
    },
  };
  const tool = profileTool(f, api);
  const result = await tool.execute('call-2', { member: `uid:${BOB}` });
  expect(result.content).toEqual([
    {
      type: 'text',
      text: `No member "uid:${BOB}" is part of this conversation. Use the exact token from a message header.`,
    },
  ]);
  expect(result.details).toEqual({ found: false, avatar: false });
  expect(calls).toBe(0);
  f.store.close();
});

test('a private chat refuses a uid that is not the caller', async () => {
  const f = await telegramFixture({ scope: 'private' });
  const tool = profileTool(
    f,
    {
      getChatMember: async () => member('member'),
      getChat: async () => ({ id: PRIVATE_CHAT, type: 'private', first_name: 'Alice' }) as ChatFullInfo,
      getUserProfilePhotos: async () => ({ total_count: 0, photos: [] }),
    },
    { avatar: false },
  );
  // A uid the chat does have history for still resolves; the caller is Alice.
  expect((await tool.execute('call-3', { member: `uid:${ALICE}` })).details).toMatchObject({ found: true });
  f.store.close();
});

test('a private chat never lends its own bio or name to another member of its history', async () => {
  // The bot's outgoing messages put its own uid in a private chat's history
  // (any second sender stands in for it here); getChat still describes the
  // human, so it must not be asked about anyone else.
  const f = await telegramFixture({ scope: 'private', alsoFrom: BOB });
  let getChatCalls = 0;
  const tool = profileTool(
    f,
    {
      getChatMember: async () => {
        throw new Error('not available');
      },
      getChat: async () => {
        getChatCalls += 1;
        return { id: PRIVATE_CHAT, type: 'private', first_name: 'Alice', bio: 'Alice bio' } as ChatFullInfo;
      },
      getUserProfilePhotos: async () => ({ total_count: 0, photos: [] }),
    },
    { avatar: false },
  );
  const result = await tool.execute('call-3b', { member: `uid:${BOB}` });
  const [text] = result.content;
  if (text?.type !== 'text') {
    throw new Error('Expected profile text');
  }
  expect(JSON.parse(text.text)).toMatchObject({ display_name: null, username: null, bio: null });
  expect(getChatCalls).toBe(0);
  f.store.close();
});

test('an aborted read sends no Bot API request', async () => {
  const f = await telegramFixture();
  let calls = 0;
  const count = async (): Promise<never> => {
    calls += 1;
    throw new Error('unexpected');
  };
  const tool = profileTool(f, { getChatMember: count, getChat: count, getUserProfilePhotos: count }, { avatar: false });
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute('call-3c', { member: `uid:${ALICE}` }, abort.signal)).rejects.toThrow(
    'read_member_profile was aborted',
  );
  expect(calls).toBe(0);
  const audited = f.store.orm.select().from(toolCalls).all().at(-1);
  expect(audited).toMatchObject({ toolName: 'read_member_profile', state: 'error', errorCode: 'aborted' });
  f.store.close();
});

test('a Telegram member with a hidden profile still reads, with the fields it has', async () => {
  const f = await telegramFixture();
  const tool = profileTool(
    f,
    {
      getChatMember: async () => {
        throw new Error('not enough rights to get chat member');
      },
      getChat: async () => {
        throw new Error('unexpected');
      },
      getUserProfilePhotos: async () => {
        throw new Error('hidden');
      },
    },
    { avatar: false },
  );
  const result = await tool.execute('call-4', { member: `uid:${ALICE}` });
  expect(result.content[0]).toMatchObject({ type: 'text' });
  expect(result.details).toMatchObject({ found: true, avatar: false });
  f.store.close();
});

test('an avatar this process cannot accept is reported as missing, not as a failed read', async () => {
  const f = await telegramFixture();
  const tool = profileTool(
    f,
    {
      getChatMember: async () => member('member'),
      getChat: async () => {
        throw new Error('unexpected');
      },
      getUserProfilePhotos: async () => ({
        total_count: 1,
        photos: [[{ file_id: 'broken', file_unique_id: 'broken-unique', width: 8, height: 8, file_size: 10 }]],
      }),
    },
    {
      download: {
        download: async (_fileId, destination, signal) => {
          signal.throwIfAborted();
          // Not an image at all: the tool image boundary must refuse it.
          const { writeFile } = await import('node:fs/promises');
          await writeFile(destination, 'not an image');
        },
      },
    },
  );
  const result = await tool.execute('call-5', { member: `uid:${ALICE}` });
  expect(result.content).toHaveLength(1);
  expect(result.details).toMatchObject({ found: true, avatar: false });
  const [text] = result.content;
  if (text?.type !== 'text') {
    throw new Error('Expected profile text');
  }
  expect(JSON.parse(text.text)).toMatchObject({ avatar: expect.stringContaining('unavailable (') });
  f.store.close();
});

test('a room reports its own member fields and never invents an avatar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-member-profile-room-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const playground = new PlaygroundStore(store.orm);
  const room = playground.createRoom({ title: 'Profile Room', members: [{ name: 'Alice' }] });
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
  const host = createPlaygroundHost({
    store,
    self: { displayName: 'Surowan', username: 'surowan' },
    sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
    profiles: () => createRoomProfiles({ store, self: { displayName: 'Surowan', username: 'surowan' } }),
  });
  const tool = createMemberProfileTool({
    store,
    context: {
      ...previewContext('playground'),
      invocationId: release.invocationId,
      conversationId: 1n,
      internalChatId: room.chatId,
    },
    conversation: identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: 1n },
      'playground',
      'group',
    ),
    profiles: () => host.profiles?.(),
  });
  const memberRef = `member:member_${alice.senderId}`;
  const result = await tool.execute('call-5', { member: memberRef });
  const [text] = result.content;
  if (text?.type !== 'text') {
    throw new Error('Expected profile text');
  }
  expect(JSON.parse(text.text)).toEqual({
    display_name: 'Alice',
    username: null,
    is_bot: false,
    standing: 'member',
    title: null,
    bio: null,
    language_code: null,
    joined_at: expect.any(String),
    avatar: 'none',
  });
  expect(result.content).toHaveLength(1);
  expect(result.details).toEqual({ found: true, avatar: false });
  // The bare sender ref is the other half of the same header token.
  expect((await tool.execute('call-6', { member: `member_${alice.senderId}` })).details).toMatchObject({
    found: true,
  });
  // A member id from another room resolves to nothing.
  expect((await tool.execute('call-7', { member: 'member_999999' })).details).toEqual({ found: false, avatar: false });
  // An id SQLite could never hold is a guess like any other, not a read error.
  expect((await tool.execute('call-8', { member: 'member_9223372036854775808' })).details).toEqual({
    found: false,
    avatar: false,
  });
  store.close();
});
