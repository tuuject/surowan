/**
 * A released room drives the real AgentRuntime against the Playground host.
 *
 * These tests run the whole invocation (context, provider, tool hooks, send)
 * so a check that only one branch of the runtime honours the host profile is
 * caught here rather than in a unit test of that branch.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { identityConversation } from '../src/platform/im-host.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import { hostSends } from '../src/store/schema.ts';
import { activeSleepUntil, enterSleep } from '../src/store/sleep.ts';
import { fauxRegistry, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function released() {
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const playground = new PlaygroundStore(store.orm);
  const room = playground.createRoom({ title: 'Runtime Room', members: [{ name: 'Alice' }] });
  playground.submit(room.chatId, { requestKey: 'req-1', senderId: room.members[0]!.senderId, text: 'hello' });
  const release = playground.release(room.chatId, {
    releaseKey: 'rel-1',
    revision: playground.room(room.chatId).revision,
  });
  if (release.invocationId === null) {
    throw new Error('expected a queued invocation');
  }
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    host: createPlaygroundHost({
      store,
      self: { displayName: 'Plastic Wan' },
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
    }),
    conversation: (target) => identityConversation(target, 'playground', 'group'),
    bot: { id: 999n, displayName: 'Plastic Wan', username: null },
    systemResources: emptySystemResources(),
  });
  return { store, configStore, runtime, faux, invocationId: release.invocationId };
}

describe('playground runtime', () => {
  test('a room keeps talking while the Telegram host sleeps', async () => {
    const { store, configStore, runtime, faux, invocationId } = await released();
    enterSleep(store.orm);
    const sleepUntil = activeSleepUntil(store.orm);
    expect(sleepUntil).not.toBeNull();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'awake in the room' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('   '),
    ]);

    const result = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);

    expect(result.reason).not.toBe('sleep');
    const sends = store.orm.select({ state: hostSends.state }).from(hostSends).all();
    expect(sends).toEqual([{ state: 'success' }]);
    // The room neither read nor ended the global window.
    expect(activeSleepUntil(store.orm)).toBe(sleepUntil);
    store.close();
  });
});
