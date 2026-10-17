import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { ExecutableCapability } from '../src/capabilities/execute-tool.ts';
import { PLAYGROUND_PROFILE, TELEGRAM_PROFILE, hostExecutionProfile } from '../src/platform/host-profile.ts';
import type { ContextInjector } from '../src/context/context-injector.ts';
import type { HostKind } from '../src/platform/im-host.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins, pluginHosts, type AgentPlugin } from '../src/plugins/plugin.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import { dailyUsage } from '../src/store/schema.ts';
import { readDailyTokenBudget } from '../src/store/sleep.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const cleanup: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const task of cleanup.reverse()) {
    await task();
  }
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-host-profile-'));
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
    chatId: 0n,
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

  test('an unlisted plugin is Telegram only', () => {
    const plugin: AgentPlugin = { id: 'unlisted' };
    expect(pluginHosts(plugin)).toEqual(['telegram']);
    expect(pluginHosts({ id: 'listed', hosts: ['playground'] })).toEqual(['playground']);
    expect(() => pluginHosts({ id: 'bad', hosts: ['discord' as never] })).toThrow(/unknown host/);
  });

  test('builtin plugins declare the hosts they serve', () => {
    const hosts = Object.fromEntries(BUILTIN_PLUGINS.map((plugin) => [plugin.id, pluginHosts(plugin)]));
    expect(hosts.alarm).toEqual(['telegram']);
    expect(hosts.dictionary).toEqual(['telegram']);
    expect(hosts.image).toEqual(['telegram']);
    expect(hosts['web-fetch']).toEqual(['telegram', 'playground']);
  });

  test('skills follow the plugin hosts', () => {
    const loaded = loadPlugins(BUILTIN_PLUGINS);
    expect(loaded.skillHosts.get('image-generation')).toEqual(['telegram']);
    expect(loaded.skillHosts.get('alarms')).toEqual(['telegram']);
    expect(loaded.skillHosts.get('web-fetch')).toEqual(['telegram', 'playground']);
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
      chatId: room.chatId,
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
      { id: 'telegram-only', contextInjectors: [injector('telegram-only')] },
      { id: 'both', hosts: ['telegram', 'playground'], contextInjectors: [injector('both')] },
      { id: 'narrowed', hosts: ['telegram', 'playground'], contextInjectors: [injector('narrowed', ['telegram'])] },
      // An injector cannot widen past its plugin.
      { id: 'widened', contextInjectors: [injector('widened', ['telegram', 'playground'])] },
    ]);

    expect(Object.fromEntries(loaded.contextInjectors.map((entry) => [entry.name, entry.hosts]))).toEqual({
      'telegram-only': ['telegram'],
      both: ['telegram', 'playground'],
      narrowed: ['telegram'],
      widened: ['telegram'],
    });
  });
});
