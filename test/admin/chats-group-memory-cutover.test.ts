import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { applyGroupMemoryToggles } from '../../src/adapters/local-monolith/runtime/chat-lifecycle.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { contextMessages, invocations } from '../../src/store/schema/index.ts';
import { seedChat } from '../memo/fixtures.ts';
import { cleanup, fixture, queue, slowHandler, useLifecycleCleanup } from './chats-lifecycle-fixtures.ts';

useLifecycleCleanup();

test('toggling group memory aborts the running Invocation and rebuilds the Conversation Context', async () => {
  const run = slowHandler();
  const f = await fixture(run.handler);
  const chat = seedChat(f.store, 123456789n);
  const contexts = new ConversationContextStore(f.store);
  const opened = contexts.open(chat.conversationId, 'seed-hash');
  contexts.append(opened.header, {
    invocationId: null,
    isCheckpoint: true,
    estTokens: 1,
    json: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'before toggle' }] }),
    role: 'user',
  });
  const id = queue(f, chat.conversationId);
  f.scheduler.start();
  await run.started.promise;
  try {
    const toggle = f.updateGroupMemory(chat.telegramChatId, { enabled: true });
    await run.aborted.promise;
    expect(f.configStore.current().config.telegram.chats[0]?.group_memory).toEqual({ enabled: true });
    run.release.resolve();
    expect((await toggle).status).toBe(200);
    expect(f.forget).toHaveBeenCalledWith(chat.conversationId);
    expect(
      f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, opened.header.id)).all(),
    ).toEqual([]);
    expect(contexts.header(chat.conversationId)).toMatchObject({
      headSeq: 1n,
      nextSeq: 1n,
      sendCountTotal: 0n,
      memoRefreshPending: true,
    });
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('aborted');
  } finally {
    run.release.resolve();
  }
});

test('a fenced Conversation keeps its queued Invocation until the fence is released', async () => {
  const handled: bigint[] = [];
  const f = await fixture(() => async (id) => {
    handled.push(id);
    return { state: 'completed', reason: 'done' };
  });
  const chat = seedChat(f.store, 123456789n);
  const id = queue(f, chat.conversationId);
  const release = f.scheduler.fenceConversations([chat.conversationId]);
  f.scheduler.start();
  // The first pass runs synchronously inside start(): an unfenced row would be running now.
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, id)).get()?.state).toBe('queued');
  expect(f.scheduler.nextDelayMilliseconds()).toBeGreaterThan(0);
  release();
  await vi.waitFor(() => expect(handled).toEqual([id]));
});

test('a handler that outlives the toggle wait keeps its Context until it settles, then the rebuild runs', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cleanup.push(async () => release.resolve());
  let firstId = 0n;
  const starts: Array<{ readonly id: bigint; readonly contextRows: number }> = [];
  const f = await fixture((fx) => async (id, _snapshot, signal) => {
    const header = new ConversationContextStore(fx.store).header(chat.conversationId);
    starts.push({
      id,
      contextRows:
        header === undefined
          ? 0
          : fx.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, header.id)).all().length,
    });
    if (id === firstId) {
      started.resolve();
      await release.promise;
    }
    return {
      state: signal.aborted ? 'aborted' : 'completed',
      reason: signal.aborted ? 'group_memory_toggled' : 'done',
    };
  });
  const chat = seedChat(f.store, 123456789n);
  const contexts = new ConversationContextStore(f.store);
  const opened = contexts.open(chat.conversationId, 'seed-hash');
  contexts.append(opened.header, {
    invocationId: null,
    isCheckpoint: true,
    estTokens: 1,
    json: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'before toggle' }] }),
    role: 'user',
  });
  firstId = queue(f, chat.conversationId);
  f.scheduler.start();
  await started.promise;
  const secondId = queue(f, chat.conversationId);
  const previous = f.configStore.current().config;
  const next = structuredClone(previous);
  const configured = next.telegram.chats[0];
  if (configured === undefined) {
    throw new Error('Missing configured Chat');
  }
  configured.group_memory = { enabled: true };
  const contextRows = () =>
    f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, opened.header.id)).all().length;
  try {
    const cutover = await applyGroupMemoryToggles(f.store, f.scheduler, f.forget, previous, next, {
      waitMilliseconds: 10,
    });
    expect(cutover).toMatchObject({ settled: false, rebuilt: 0, invocations: 1 });
    // The stale handler still owns its header: nothing is reset under it.
    expect(contextRows()).toBe(1);
    expect(f.forget).not.toHaveBeenCalled();
    release.resolve();
    expect(await cutover.completion).toBe(1);
    expect(contextRows()).toBe(0);
    expect(contexts.header(chat.conversationId)).toMatchObject({ headSeq: 1n, nextSeq: 1n });
    expect(f.forget).toHaveBeenCalledWith(chat.conversationId);
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, firstId)).get()?.state).toBe('aborted');
    // The queued run was held by the fence and starts only on the rebuilt Context.
    await vi.waitFor(() => expect(starts.map((entry) => entry.id)).toEqual([firstId, secondId]));
    expect(starts[1]?.contextRows).toBe(0);
  } finally {
    release.resolve();
  }
});
