import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { ExecutableCapability } from '../../src/capabilities/execute-tool.ts';
import {
  PLAYGROUND_PROFILE,
  TELEGRAM_PROFILE,
  hostExecutionProfile,
  hostsWhere,
  policyScopeChatId,
} from '../../src/platform/host-profile.ts';
import type { ContextInjector } from '../../src/context/injector.ts';
import type { HostKind } from '../../src/platform/im-host/identity.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { loadPlugins, pluginHosts } from '../../src/plugins/plugin.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { dailyUsage } from '../../src/store/schema/index.ts';
import { readDailyTokenBudget } from '../../src/store/sleep.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';

const cleanup: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const task of cleanup.reverse()) {
    await task();
  }
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-host-profile-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(directory, path, testConfigJsonc(directory));
  const loaded = await loadConfig(path);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { store, config: loaded.config };
}

function context(overrides: Partial<InvocationContext>): InvocationContext {
  return {
    invocationId: 0n,
    conversationId: 0n,
    hostChatId: 0n,
    internalChatId: 0n,
    callerUserId: 0n,
    messageId: null,
    hostKind: 'telegram',
    ...overrides,
  } as InvocationContext;
}

function toolNames(tools: readonly ExecutableCapability[]): string[] {
  return tools.map((capability) => capability.tool.name).sort();
}

describe('host execution profile', () => {
  test('the Playground profile is a fixed narrow set', () => {
    expect(hostExecutionProfile('playground')).toBe(PLAYGROUND_PROFILE);
    expect(hostExecutionProfile('telegram')).toBe(TELEGRAM_PROFILE);

    expect(PLAYGROUND_PROFILE.mediaRead).toBe(true);
    expect(PLAYGROUND_PROFILE.stickers).toBe(false);
    expect(PLAYGROUND_PROFILE.mcp).toBe(false);
    expect(PLAYGROUND_PROFILE.sleep).toBe(false);
    expect(PLAYGROUND_PROFILE.budgetScope).toBe('playground');
    expect(PLAYGROUND_PROFILE.budgetBypass).toBe(false);

    expect(TELEGRAM_PROFILE.mcp).toBe(true);
    expect(TELEGRAM_PROFILE.sleep).toBe(true);
    expect(TELEGRAM_PROFILE.budgetScope).toBe('chat');
    expect(TELEGRAM_PROFILE.budgetBypass).toBe(true);
  });

  test('each new trait equals the branch it replaced', () => {
    // A room never waits on the global sleep, never resolves a configured chat
    // entry, never downloads media and never holds a process connection.
    expect(PLAYGROUND_PROFILE.chatSource).toBe('room');
    expect(PLAYGROUND_PROFILE.intake).toBe('release');
    expect(PLAYGROUND_PROFILE.deliveryRecord).toBe('sequence');
    expect(PLAYGROUND_PROFILE.mediaSource).toBe('local_asset');
    expect(PLAYGROUND_PROFILE.connection).toBe('none');
    expect(PLAYGROUND_PROFILE.snapshotFormat).toBe('plasticwan.invocation-snapshot.playground.v1');

    expect(TELEGRAM_PROFILE.chatSource).toBe('config');
    expect(TELEGRAM_PROFILE.intake).toBe('bucket');
    expect(TELEGRAM_PROFILE.deliveryRecord).toBe('wire');
    expect(TELEGRAM_PROFILE.mediaSource).toBe('download');
    expect(TELEGRAM_PROFILE.connection).toBe('registry');
    expect(TELEGRAM_PROFILE.snapshotFormat).toBe('plasticwan.invocation-snapshot.v1');
  });

  test('hostsWhere selects hosts by trait in a stable order', () => {
    expect(hostsWhere((profile) => profile.chatSource === 'config')).toEqual(['telegram']);
    expect(hostsWhere((profile) => profile.connection === 'none')).toEqual(['playground']);
    expect(hostsWhere((profile) => profile.mediaSource === 'download')).toEqual(['telegram']);
    expect(hostsWhere((profile) => profile.sleep)).toEqual(['telegram']);
  });

  test('policyScopeChatId picks the id the host is addressed by', () => {
    expect(policyScopeChatId('telegram', { hostChatId: 7n, chatId: 3n })).toBe(7n);
    expect(policyScopeChatId('playground', { hostChatId: null, chatId: 3n })).toBe(3n);
    // A config-sourced chat that lost its native id is a storage bug, not a
    // silent `0n` scope shared by every such row.
    expect(() => policyScopeChatId('telegram', { hostChatId: null, chatId: 3n })).toThrow(/host chat id/i);
  });

  test('model-visible wording stays pinned per host', () => {
    expect(TELEGRAM_PROFILE.wording.historyTag).toBe('untrusted_telegram_history');
    expect(PLAYGROUND_PROFILE.wording.historyTag).toBe('untrusted_room_history');
    expect(TELEGRAM_PROFILE.wording.readImageLabel).toBe('Read Telegram image');
    expect(PLAYGROUND_PROFILE.wording.readImageLabel).toBe('Read room image');
    expect(TELEGRAM_PROFILE.wording.memberProfileLabel).toBe('Read Telegram member profile');
    expect(PLAYGROUND_PROFILE.wording.memberProfileLabel).toBe('Read room member profile');
  });

  test('plugin hosts are declared explicitly and validated', () => {
    expect(pluginHosts({ id: 'listed', hosts: ['playground'] })).toEqual(['playground']);
    expect(() => pluginHosts({ id: 'bad', hosts: ['discord' as never] })).toThrow(/unknown host/);
  });

  test('capabilities do not leak Telegram-only plugins into a room', async () => {
    const { store, config } = await openStore();
    const loaded = loadPlugins(BUILTIN_PLUGINS);

    const telegram = toolNames(
      loaded.capabilities(store, config, context({ hostKind: 'telegram' }), Date.now(), undefined, undefined),
    );
    const playground = toolNames(
      loaded.capabilities(store, config, context({ hostKind: 'playground' }), Date.now(), undefined, undefined),
    );

    expect(telegram).toContain('alarm');
    expect(telegram).toContain('lookup_dictionary');
    expect(telegram).toContain('web_fetch');

    expect(playground).not.toContain('alarm');
    expect(playground).not.toContain('lookup_dictionary');
    expect(playground).toContain('web_fetch');
  });

  test('a plugin cannot create room tasks when it is not registered for the room host', async () => {
    const { store } = await openStore();
    const room = new PlaygroundStore(store.orm).createRoom({ title: 'Room' });
    const service = new LongTaskService(store.orm);
    const live = context({
      hostKind: 'playground',
      invocationId: 1n,
      conversationId: room.conversationId,
      hostChatId: room.chatId,
      internalChatId: room.chatId,
    });

    expect(() => service.invocationScope('alarm', live, ['telegram'])).toThrow(/not enabled on the playground host/);
    expect(() => service.invocationScope('web-fetch', live, ['telegram', 'playground'])).not.toThrow();
  });

  test('the Playground budget is accumulated on its own scope', async () => {
    const { store } = await openStore();
    const day = new Date('2026-10-17T04:00:00Z');
    const utcDate = day.toISOString().slice(0, 10);
    store.orm
      .insert(dailyUsage)
      .values([
        { utcDate, scope: 'chat', resource: '1', metric: 'model_tokens', amount: 100n, updatedAt: day.toISOString() },
        {
          utcDate,
          scope: 'playground',
          resource: '2',
          metric: 'model_tokens',
          amount: 7n,
          updatedAt: day.toISOString(),
        },
      ])
      .run();

    expect(readDailyTokenBudget(store.orm, 1000, { scope: 'chat', now: day }).usedTokens).toBe(100n);
    expect(readDailyTokenBudget(store.orm, 1000, { scope: 'playground', now: day }).usedTokens).toBe(7n);
    expect(readDailyTokenBudget(store.orm, 1000, { now: day }).usedTokens).toBe(100n);
  });

  test('a context injector runs only on the hosts its plugin runs on', () => {
    const injector = (name: string, hosts?: readonly HostKind[]): ContextInjector => {
      const base = { name, collect: () => [], render: () => ({ text: '', signatures: [], count: 0 }) };
      return hosts === undefined ? base : { ...base, hosts };
    };
    const loaded = loadPlugins([
      { id: 'telegram-only', hosts: ['telegram'], contextInjectors: [injector('telegram-only')] },
      { id: 'both', hosts: ['telegram', 'playground'], contextInjectors: [injector('both')] },
      { id: 'narrowed', hosts: ['telegram', 'playground'], contextInjectors: [injector('narrowed', ['telegram'])] },
      // An injector cannot widen past its plugin.
      { id: 'widened', hosts: ['telegram'], contextInjectors: [injector('widened', ['telegram', 'playground'])] },
    ]);

    expect(Object.fromEntries(loaded.contextInjectors.map((entry) => [entry.name, entry.hosts]))).toEqual({
      'telegram-only': ['telegram'],
      both: ['telegram', 'playground'],
      narrowed: ['telegram'],
      widened: ['telegram'],
    });
  });
});
