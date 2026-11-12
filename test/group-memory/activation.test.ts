import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { publishGroupMemory } from '../../src/adapters/local-monolith/runtime/chat-lifecycle.ts';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { countPendingMessages } from '../../src/context/group-memory/messages.ts';
import { invocations } from '../../src/store/schema/index.ts';
import { seedInvocation } from '../memo/fixtures.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test('enabling fixes the lane boundary before waiting for a running Invocation', async () => {
  const f = await groupMemoryFixture({ enabled: false });
  const release = Promise.withResolvers<boolean>();
  const waiting = Promise.withResolvers<void>();
  try {
    const now = new Date();
    seedMessage(f.store, f, { telegramMessageId: 100, date: now, text: 'before enable' });
    const invocationId = seedInvocation(f.store, f.conversationId);
    f.store.orm.update(invocations).set({ state: 'running' }).where(eq(invocations.id, invocationId)).run();
    const snapshot = f.configStore.current();
    const next = structuredClone(snapshot.config);
    const chat = next.telegram.chats[0];
    if (chat === undefined) {
      throw new Error('Missing Chat');
    }
    chat.group_memory = { enabled: true };
    f.configStore.publish({ ...snapshot, config: next });
    const service = new SleepingService({
      store: f.store,
      configStore: f.configStore,
      secrets: f.secrets,
      isHostReady: () => true,
    });
    const publish = publishGroupMemory(
      {
        store: f.store,
        stopper: {
          fenceConversations: () => () => undefined,
          abortInvocations: () => 1,
          waitForInvocations: () => {
            waiting.resolve();
            return release.promise;
          },
          settleInvocations: async () => undefined,
        },
        forgetConversation: () => undefined,
        reconcileLanes: (config) => service.reconcile(config, now),
        redactError: String,
      },
      snapshot.config,
      next,
    );
    await waiting.promise;
    seedMessage(f.store, f, { telegramMessageId: 101, date: now, text: 'after enable' });
    release.resolve(true);
    expect(await publish).toMatchObject({ cutover: true, failure: undefined });
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(100n);
    expect(countPendingMessages(f.store.orm, f.chatId, { after: 100n, until: null })).toBe(1);
  } finally {
    release.resolve(true);
    await f.close();
  }
});

test('a failed activation retains its first cursor and reports a publish failure', async () => {
  const f = await groupMemoryFixture({ enabled: false });
  try {
    const now = new Date();
    seedMessage(f.store, f, { telegramMessageId: 100, date: now, text: 'before enable' });
    const snapshot = f.configStore.current();
    const next = structuredClone(snapshot.config);
    const chat = next.telegram.chats[0];
    if (chat === undefined) {
      throw new Error('Missing Chat');
    }
    chat.group_memory = { enabled: true };
    f.configStore.publish({ ...snapshot, config: next });
    const service = new SleepingService({
      store: f.store,
      configStore: f.configStore,
      secrets: f.secrets,
      isHostReady: () => true,
    });
    const activate = vi.spyOn(GroupMemoryStore.prototype, 'activate').mockImplementationOnce(() => {
      throw new Error('activation unavailable');
    });
    const result = await publishGroupMemory(
      {
        store: f.store,
        stopper: undefined,
        forgetConversation: () => undefined,
        reconcileLanes: (config) => service.reconcile(config, now),
        redactError: String,
      },
      snapshot.config,
      next,
    );
    expect(result.cutover).toBe(false);
    expect(result.failure).toEqual(new Error('activation unavailable'));
    seedMessage(f.store, f, { telegramMessageId: 101, date: now, text: 'after failed activation' });
    service.reconcile(next, now);
    expect(activate).toHaveBeenLastCalledWith(f.chatId, 100n, now);
    expect(f.groupMemory.lane(f.chatId, 'live')?.throughMessageId).toBe(100n);
    expect(countPendingMessages(f.store.orm, f.chatId, { after: 100n, until: null })).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
