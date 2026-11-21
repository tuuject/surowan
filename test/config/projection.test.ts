/**
 * IMH-04 behavior tests for the configuration projection and the A8 identity
 * split: a room never sees a Telegram chat entry's settings — even when its
 * internal chat id numerically equals a configured Telegram chat id — and a
 * migrated group keeps resolving the entry authored for its predecessor.
 */
import { describe, expect, test } from 'vitest';
import {
  allConfiguredChats,
  configuredChats,
  hostIntakeSettings,
  mapConfiguredChats,
  type RawConfig,
  resolveChatConfig,
} from '../../src/platform/config/index.ts';
import { resolveDecisionGate } from '../../src/platform/decision-gate.ts';
import { invocationGateKey, resolveInvocationPolicy } from '../../src/platform/invocation-policy.ts';
import { modelsForChats } from '../../src/platform/providers.ts';
import { chatMigrations } from '../../src/store/schema/index.ts';
import { openTestStore, seedPlaygroundConversation, seedTelegramConversation } from '../im/fixtures.ts';

const OLD_CHAT = -100_111_222_333;
const NEW_CHAT = -100_444_555_666;

function configWith(chats: { id: number; [key: string]: unknown }[]): RawConfig {
  return {
    telegram: { chats },
    timezone: 'UTC',
    agent: { provider: 'agent-provider', model: 'agent-model' },
  } as unknown as RawConfig;
}

describe('resolveChatConfig', () => {
  test('a migrated group resolves the entry authored for its predecessor id', async () => {
    const { store } = await openTestStore();
    store.orm
      .insert(chatMigrations)
      .values({ oldChatId: BigInt(OLD_CHAT), newChatId: BigInt(NEW_CHAT), receivedAt: '2025-01-01T00:00:00.000Z' })
      .run();
    const config = configWith([{ id: OLD_CHAT, provider: 'chat-provider', model: 'chat-model' }]);
    // The bot must not go silent after a group migration: the new id finds
    // the predecessor's entry.
    expect(resolveChatConfig(config, store.orm, { hostKind: 'telegram', hostChatId: BigInt(NEW_CHAT) })?.id).toBe(
      OLD_CHAT,
    );
    expect(resolveChatConfig(config, store.orm, { hostKind: 'telegram', hostChatId: BigInt(OLD_CHAT) })?.id).toBe(
      OLD_CHAT,
    );
  });

  test('a resolved Chat entry carries its decision_gate override', async () => {
    const { store } = await openTestStore();
    const config = configWith([{ id: OLD_CHAT, decision_gate: { threshold: 0.9, mode: 'enforce' } }]);
    const entry = resolveChatConfig(config, store.orm, { hostKind: 'telegram', hostChatId: BigInt(OLD_CHAT) });
    // The override travels on the resolved entry, exactly like proactive_reply,
    // so the gate resolves its settings from the object it already has.
    expect(entry?.decision_gate).toEqual({ threshold: 0.9, mode: 'enforce' });
    const settings = resolveDecisionGate({}, entry);
    expect(settings.threshold).toBe(0.9);
    expect(settings.mode).toBe('enforce');
    expect(settings.enabled).toBe(false);
  });

  test('a room never resolves a Telegram chat entry, even on a colliding id', async () => {
    const { store } = await openTestStore();
    const config = configWith([{ id: 7, provider: 'chat-provider', model: 'chat-model' }]);
    expect(resolveChatConfig(config, store.orm, { hostKind: 'playground', hostChatId: null })).toBeUndefined();
    // A room whose internal chat id equals a configured Telegram chat id
    // still resolves nothing: the entry belongs to Telegram, not to the room.
    expect(resolveChatConfig(config, store.orm, { hostKind: 'playground', hostChatId: 7n })).toBeUndefined();
    // A Telegram chat missing from the file is unconfigured by definition.
    expect(resolveChatConfig(config, store.orm, { hostKind: 'telegram', hostChatId: 999n })).toBeUndefined();
  });
});

describe('configured chat enumeration', () => {
  test('configuredChats scopes entries to their host; a room host has none', () => {
    const config = configWith([{ id: 1 }, { id: 2 }]);
    expect(configuredChats(config, 'telegram').map((chat) => chat.id)).toEqual([1, 2]);
    expect(configuredChats(config, 'playground')).toEqual([]);
    expect(allConfiguredChats(config).map((entry) => [entry.host, entry.chat.id])).toEqual([
      ['telegram', 1],
      ['telegram', 2],
    ]);
  });

  test('mapConfiguredChats rewrites only chat entries and shares every other field', () => {
    const config = configWith([{ id: 1 }, { id: 2 }]);
    const next = mapConfiguredChats(config, (chat) => ({ ...chat, model: 'switched' }));
    expect(next.telegram.chats.map((chat) => chat.model)).toEqual(['switched', 'switched']);
    expect(next.agent).toBe(config.agent);
    expect(next.timezone).toBe('UTC');
    expect(config.telegram.chats[0]?.model).toBeUndefined();
  });
});

describe('hostIntakeSettings', () => {
  test('telegram reads its own section; a room gets neutral values', () => {
    const config = {
      telegram: {
        chats: [],
        process_bot_messages: true,
        admins: [42],
        participation: { ask_only: true },
        proactive_reply: { enabled: true },
        decision_gate: { enabled: true, mode: 'enforce' },
      },
      timezone: 'UTC',
      agent: { provider: 'agent-provider', model: 'agent-model' },
    } as unknown as RawConfig;
    const telegram = hostIntakeSettings(config, 'telegram');
    expect(telegram.process_bot_messages).toBe(true);
    expect(telegram.admins).toEqual([42]);
    expect(telegram.participation?.ask_only).toBe(true);
    expect(telegram.proactive_reply?.enabled).toBe(true);
    expect(telegram.decision_gate?.enabled).toBe(true);
    expect(telegram.decision_gate?.mode).toBe('enforce');
    const room = hostIntakeSettings(config, 'playground');
    expect(room.process_bot_messages).toBe(false);
    expect(room.admins).toEqual([]);
    expect(room.participation).toBeUndefined();
    expect(room.proactive_reply).toBeUndefined();
    // A room never runs the entry gate: its batches are released explicitly.
    expect(room.decision_gate).toBeUndefined();
  });
});

describe('invocation scope identity', () => {
  test('a room policy uses the global agent even when its chat id collides with a configured chat', async () => {
    const { store } = await openTestStore();
    // Seed a room whose internal chat id numerically equals a configured
    // Telegram chat id — the collision the split exists to defuse. The
    // Telegram row itself keeps a different internal id; only its native id
    // matches the file entry.
    const telegram = seedTelegramConversation(store, { chatId: 8n, telegramChatId: 9n });
    const room = seedPlaygroundConversation(store, { chatId: 9n, conversationId: 90n });
    const config = configWith([
      { id: 9, provider: 'chat-provider', model: 'chat-model', instructions: 'telegram only' },
    ]);
    const policy = resolveInvocationPolicy(config, store.orm, {
      hostKind: 'playground',
      chatId: room.chatId,
      hostChatId: null,
      chatType: 'group',
    });
    expect(policy.agent).toEqual({ provider: 'agent-provider', model: 'agent-model' });
    expect(policy.instructions).toBe('');
    expect(policy.gateKey).toBe('playground:9');
    const telegramPolicy = resolveInvocationPolicy(config, store.orm, {
      hostKind: 'telegram',
      chatId: telegram.chatId,
      hostChatId: 9n,
      chatType: 'supergroup',
    });
    expect(telegramPolicy.agent).toEqual({ provider: 'chat-provider', model: 'chat-model' });
    expect(telegramPolicy.instructions).toBe('telegram only');
    expect(telegramPolicy.gateKey).toBe('telegram:9');
  });

  test('an unconfigured Telegram chat cannot resolve a policy at all', async () => {
    const { store } = await openTestStore();
    const config = configWith([{ id: 1 }]);
    expect(() =>
      resolveInvocationPolicy(config, store.orm, {
        hostKind: 'telegram',
        chatId: 1n,
        hostChatId: 999n,
        chatType: 'supergroup',
      }),
    ).toThrow(/no longer configured/);
  });

  test('the gate key is host-prefixed so equal ids on two hosts never share a gate', () => {
    expect(invocationGateKey('telegram', 9n)).toBe('telegram:9');
    expect(invocationGateKey('playground', 9n)).toBe('playground:9');
  });
});

describe('modelsForChats', () => {
  test('chat-scoped model selection never leaks across hosts', () => {
    const config = configWith([{ id: 9, provider: 'agent-provider', model: 'chat-model', thinking_level: 'low' }]);
    const models = [
      { provider: 'agent-provider', id: 'agent-model' },
      { provider: 'agent-provider', id: 'chat-model' },
    ] as unknown as Parameters<typeof modelsForChats>[1];
    expect(modelsForChats(config, models, [9], 'telegram').map((model) => model.id)).toEqual(['chat-model']);
    // A room has no configured entries: the same numeric id resolves nothing.
    expect(modelsForChats(config, models, [9], 'playground')).toEqual([]);
  });
});
