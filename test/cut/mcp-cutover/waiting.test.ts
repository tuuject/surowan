/**
 * Waiting, handing off and queueing: a handler that outlives the in-line wait
 * keeps its Context, a publish behind a stuck cutover returns in bounded time,
 * and a forum topic created during the wait is fenced before the swap.
 */
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ConversationContextStore } from '../../../src/context/store/index.ts';
import { contextMessages, conversations, invocations } from '../../../src/store/schema/index.ts';
import { seedChat } from '../../memo/fixtures.ts';
import { CHAT_A, fixture, now, queueInvocation, seedContext, server, withChangedAlpha } from './shared.ts';

test('a handler that outlives the wait keeps its Context until it settles, then the cutover finishes', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  const seeded = seedContext(f.store, chat.conversationId, 'still working');
  const invocationId = queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  const release = f.hold();
  const alphaState = f.store.db
    .prepare<[], { registry_hash: string | null }>("SELECT registry_hash FROM mcp_server_state WHERE alias = 'alpha'")
    .get();

  const pending = await f.apply(withChangedAlpha(f.configStore.current().config));
  expect(pending).toMatchObject({ settled: false, rebuiltContexts: 0, stoppedInvocations: 1 });
  expect(pending.servers).toEqual({ added: [], replaced: [], removed: [], failed: [], stale: false });
  // Nothing was rebuilt and no instance moved under the still-running handler.
  const contexts = new ConversationContextStore(f.store);
  expect(contexts.header(chat.conversationId)?.generation).toBe(seeded.generation);
  expect(f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, seeded.id)).all()).toHaveLength(
    1,
  );
  expect(f.forgotten).toEqual([]);
  expect(
    f.store.db
      .prepare<[], { registry_hash: string | null }>("SELECT registry_hash FROM mcp_server_state WHERE alias = 'alpha'")
      .get(),
  ).toEqual(alphaState);

  release();
  await pending.completion;
  expect(contexts.header(chat.conversationId)?.generation).toBe(seeded.generation + 1n);
  expect(f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, seeded.id)).all()).toEqual([]);
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get()?.state).toBe('aborted');
  const resumed = f.store.orm
    .select()
    .from(invocations)
    .where(eq(invocations.resumedFromInvocationId, invocationId))
    .get();
  expect(resumed).toBeDefined();
  expect(
    f.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'mcp_config_published')
      .map((entry) => entry.settled),
  ).toEqual([false, true]);
});

test('a publish queued behind a stuck cutover returns promptly and both finish in order', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  seedContext(f.store, chat.conversationId, 'working');
  queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  const release = f.hold();

  const first = await f.apply(withChangedAlpha(f.configStore.current().config));
  expect(first.settled).toBe(false);

  // The operator publishes again while the first cutover's handler refuses to
  // settle. The reload lock must not be held for that, so the second publish
  // reports itself pending after the bounded queue wait.
  const next = structuredClone(f.configStore.current().config);
  next.mcp = { servers: [...(next.mcp?.servers ?? []), server('gamma', join(f.directory, 'gamma.pid'))] };
  const startedAt = Date.now();
  const second = await f.apply(next);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(second.settled).toBe(false);
  // Nothing of the queued cutover has run yet.
  expect(
    f.store.db.prepare<[], { state: string }>("SELECT state FROM mcp_server_state WHERE alias = 'gamma'").get(),
  ).toBeUndefined();

  release();
  await first.completion;
  await second.completion;
  // The stuck cutover finished (and reconciled) before the queued one ran, and
  // the manager ends on the latest published configuration.
  const events = f.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'mcp_config_published')
    .map((entry) => [entry.settled, entry.replaced_servers, entry.added_servers]);
  expect(events).toEqual([
    [false, '', ''],
    [false, '', ''],
    [true, 'alpha', ''],
    [true, '', 'gamma'],
  ]);
  expect(
    f.store.db.prepare<[], { state: string }>("SELECT state FROM mcp_server_state WHERE alias = 'gamma'").get()?.state,
  ).toBe('ready');
});

test('a forum topic created while the cutover waits is fenced and rebuilt too', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  seedContext(f.store, chat.conversationId, 'first topic');
  queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  const release = f.hold();

  const pending = await f.apply(withChangedAlpha(f.configStore.current().config));
  expect(pending.settled).toBe(false);

  // A new topic appears while the first pass waits, so it is not in the fenced
  // set the cutover started with. Its own batch queues behind the still-running
  // run of the same Chat (the scheduler launches one Invocation per Chat).
  const topicConversation = f.store.orm
    .insert(conversations)
    .values({ chatId: chat.chatId, messageThreadId: 7n, createdAt: now(), updatedAt: now() })
    .returning({ id: conversations.id })
    .get()!.id;
  const topicContext = seedContext(f.store, topicConversation, 'new topic question');
  const topicInvocation = queueInvocation(f.store, topicConversation, new Date(Date.now() - 30_000).toISOString());

  release();
  await pending.completion;

  // The second pass fenced it and rebuilt its Context before the instances
  // moved, so the queued batch starts on the new tool set and a fresh Context.
  expect(
    f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, topicContext.id)).all(),
  ).toEqual([]);
  expect(f.forgotten).toContain(topicConversation);
  expect(new ConversationContextStore(f.store).header(topicConversation)?.generation).toBe(
    topicContext.generation + 1n,
  );
  // Whichever won the race with the scheduler, it never kept running into the
  // swap: either it was still queued behind the fence, or the second pass
  // stopped it and queued its continuation.
  const state = f.store.orm.select().from(invocations).where(eq(invocations.id, topicInvocation)).get()?.state;
  expect(['queued', 'aborted']).toContain(state);
  if (state === 'aborted') {
    expect(
      f.store.orm.select().from(invocations).where(eq(invocations.resumedFromInvocationId, topicInvocation)).get(),
    ).toBeDefined();
  }
});
