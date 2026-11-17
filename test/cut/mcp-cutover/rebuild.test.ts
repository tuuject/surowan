/**
 * Stopping a Chat's run, rebuilding its Context and continuing it: the core of
 * the cutover, plus the history window the continuation has to reach back over.
 */
import { eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { ConversationContextStore } from '../../../src/context/store/index.ts';
import { contextMessages, contextRefs, invocations, messages } from '../../../src/store/schema/index.ts';
import { finishToolCall, startToolCall } from '../../../src/store/store.ts';
import { seedMessage } from '../../group-memory/fixtures.ts';
import { renderInvocationContext } from '../../helpers.ts';
import { seedChat } from '../../memo/fixtures.ts';
import { CHAT_A, CHAT_B, fixture, queueInvocation, seedContext, withChangedAlpha } from './shared.ts';

test('a changed bound server stops only its Chat, rebuilds its Context and queues a continuation', async () => {
  const f = await fixture();
  const chatA = seedChat(f.store, BigInt(CHAT_A));
  const chatB = seedChat(f.store, BigInt(CHAT_B));
  const seededA = seedContext(f.store, chatA.conversationId, 'unanswered question');
  const seededB = seedContext(f.store, chatB.conversationId, 'chat b transcript');
  const injectedAt = new Date(Date.now() - 60_000).toISOString();
  const invocationA = queueInvocation(f.store, chatA.conversationId, injectedAt);
  const invocationB = queueInvocation(f.store, chatB.conversationId, injectedAt);
  f.scheduler.start();
  await f.whenStarted(2);
  // The stopped run may have executed this call without learning its outcome.
  const unknownAudit = startToolCall(f.store.orm, invocationA, 'mcp-unknown', 'alpha__echo', '{"value":1}', true);
  finishToolCall(f.store.orm, unknownAudit, 'outcome_unknown', null, 'timeout');

  const result = await f.apply(withChangedAlpha(f.configStore.current().config));

  expect(result).toMatchObject({ affectedChats: [CHAT_A], stoppedInvocations: 1, settled: true });
  expect(result.servers).toMatchObject({ replaced: ['alpha'], removed: [], added: [], failed: [], stale: false });
  expect(result.resumedInvocations).toHaveLength(1);
  // Chat A's Context was rebuilt: no messages, no refs, reset counters, new generation.
  const contexts = new ConversationContextStore(f.store);
  const headerA = contexts.header(chatA.conversationId);
  expect(headerA).toMatchObject({ headSeq: 1n, nextSeq: 1n, sendCountTotal: 0n });
  expect(headerA!.generation).toBe(seededA.generation + 1n);
  expect(f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, seededA.id)).all()).toEqual([]);
  expect(f.store.orm.select().from(contextRefs).where(eq(contextRefs.contextId, seededA.id)).all()).toEqual([]);
  expect(f.forgotten).toContain(chatA.conversationId);
  const stopped = f.store.orm.select().from(invocations).where(eq(invocations.id, invocationA)).get();
  expect(stopped?.state).toBe('aborted');
  expect(stopped?.abortCause).toBe('mcp_config_changed');
  expect(JSON.parse(stopped?.abortUnknownTools ?? '[]')).toEqual(['alpha__echo']);
  // Chat B was not touched at all.
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, invocationB)).get()?.state).toBe('running');
  expect(contexts.header(chatB.conversationId)?.generation).toBe(seededB.generation);
  expect(
    f.store.orm.select().from(contextMessages).where(eq(contextMessages.contextId, seededB.id)).all(),
  ).toHaveLength(1);
  expect(f.forgotten).not.toContain(chatB.conversationId);

  // The continuation is linked to the stopped run and opens on the new Context.
  const resumed = f.store.orm
    .select()
    .from(invocations)
    .where(eq(invocations.resumedFromInvocationId, invocationA))
    .get();
  expect(resumed?.conversationId).toBe(chatA.conversationId);
  expect(['queued', 'running']).toContain(resumed?.state);
  const rendering = renderInvocationContext(f.store, f.configStore.current().config, resumed!.id, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  expect(rendering.userPrompt).toContain("The operator changed this chat's MCP configuration");
  expect(rendering.userPrompt).toContain('context was rebuilt');
  expect(rendering.userPrompt).toContain('may contain messages that have not been answered yet');
  expect(rendering.userPrompt).toContain('alpha__echo');
  expect(rendering.userPrompt).toContain('This batch has no new messages');
  expect(rendering.userPrompt).not.toContain('An administrator resumed');

  // One event records the whole cutover.
  const event = f.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === 'mcp_config_published');
  expect(event).toMatchObject({
    affected_chats: String(CHAT_A),
    stopped_invocations: 1,
    rebuilt_contexts: 1,
    resumed_invocations: 1,
    replaced_servers: 'alpha',
    settled: true,
  });
});

test('a run that already finished its round and only waits is not continued', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  seedContext(f.store, chat.conversationId, 'answered question');
  const invocationId = queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  // The model produced its tool-less turn: the run now idles in `idle_grace`.
  f.endRound(chat.conversationId);

  const result = await f.apply(withChangedAlpha(f.configStore.current().config));

  expect(result.resumedInvocations).toEqual([]);
  expect(result.skippedResumes).toEqual([{ invocationId, reason: 'idle' }]);
  expect(
    f.store.orm.select().from(invocations).where(eq(invocations.resumedFromInvocationId, invocationId)).all(),
  ).toEqual([]);
  expect(f.store.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get()?.state).toBe('aborted');
});

test('an unknown-outcome call of a non-MCP tool is not named in the trusted line', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  seedContext(f.store, chat.conversationId, 'question');
  const invocationId = queueInvocation(f.store, chat.conversationId, new Date(Date.now() - 60_000).toISOString());
  f.scheduler.start();
  await f.whenStarted(1);
  const auditId = startToolCall(f.store.orm, invocationId, 'exec-unknown', 'execute', '{}', true);
  finishToolCall(f.store.orm, auditId, 'outcome_unknown', null, 'timeout');

  const result = await f.apply(withChangedAlpha(f.configStore.current().config));
  expect(result.resumedInvocations).toHaveLength(1);
  expect(
    f.store.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get()?.abortUnknownTools,
  ).toBeNull();
});

test('the continuation renders a batch wider than agent.history_messages', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const texts: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    texts.push(`request-${index}`);
    seedMessage(
      f.store,
      { chatId: chat.chatId, conversationId: chat.conversationId },
      {
        telegramMessageId: index,
        date: new Date(base + index * 1_000),
        text: `request-${index}`,
      },
    );
  }
  const invocationId = queueInvocation(f.store, chat.conversationId, new Date(base + 60_000).toISOString());
  const bucketId = f.store.orm
    .select({ id: invocations.bucketId })
    .from(invocations)
    .where(eq(invocations.id, invocationId))
    .get()!.id;
  for (const [sequence, message] of f.store.orm
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, chat.conversationId))
    .all()
    .entries()) {
    f.store.orm.run(
      sql`INSERT INTO bucket_messages(bucket_id, message_id, sequence_no, source_bucket_id)
        VALUES (${bucketId}, ${message.id}, ${BigInt(sequence)}, ${bucketId})`,
    );
  }
  f.scheduler.start();
  await f.whenStarted(1);

  // The operator's apply narrows the history window far below this batch.
  const result = await f.apply(
    withChangedAlpha(f.configStore.current().config, (next) => {
      next.agent = { ...next.agent, history_messages: 2 };
    }),
  );
  expect(result.resumedInvocations).toHaveLength(1);
  const rendering = renderInvocationContext(f.store, f.configStore.current().config, result.resumedInvocations[0]!, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  // The rebuilt Context is empty, so the snapshot is the only way the model sees
  // what it was answering.
  for (const text of texts) {
    expect(rendering.userPrompt).toContain(text);
  }
});
