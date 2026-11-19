/**
 * Where the follow-up run comes from: a tool handed out by a replaced instance
 * must not reach the replacement, a batch the stopped run never received becomes
 * the continuation, and a task completion it was rendering is re-delivered.
 */
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { RECURRING_ALARM_PLUGIN_ID } from '../../../src/store/recurring-alarms/payload.ts';
import {
  bucketMessages,
  buckets,
  invocationBuckets,
  invocations,
  longTasks,
  taskReceipts,
} from '../../../src/store/schema/index.ts';
import { finishToolCall, startToolCall } from '../../../src/store/store.ts';
import { seedMessage } from '../../group-memory/fixtures.ts';
import { renderInvocationContext } from '../../helpers.ts';
import { seedChat } from '../../memo/fixtures.ts';
import { CHAT_A, contextFor, type Fixture, fixture, now, queueInvocation, textOf, withChangedAlpha } from './shared.ts';

test('a tool handed out by a replaced instance is rejected instead of reaching the replacement', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  const invocationId = queueInvocation(f.store, chat.conversationId, new Date().toISOString());
  const previous = f.configStore.current().config;
  const context = contextFor(invocationId, BigInt(CHAT_A), chat.chatId, chat.conversationId);
  const stale = f.manager
    .createTools(context, Date.now() + 30_000, previous)
    .find((tool) => tool.name === 'alpha__echo');
  if (stale === undefined) {
    throw new Error('Missing alpha tool');
  }

  const next = withChangedAlpha(previous);
  const result = await f.apply(next);
  expect(result.servers).toMatchObject({ replaced: ['alpha'] });

  await expect(stale.execute('mcp-replaced', { text: 'old instance' })).rejects.toThrow(/was replaced/);
  const audit = f.store.db
    .prepare<[], { tool_call_id: string; state: string; error_code: string | null }>(
      "SELECT tool_call_id, state, error_code FROM tool_calls WHERE tool_call_id = 'mcp-replaced'",
    )
    .get();
  expect(audit).toEqual({ tool_call_id: 'mcp-replaced', state: 'error', error_code: 'server_replaced' });

  // The replacement never received the request: its own call counter starts at 1.
  const fresh = f.manager.createTools(context, Date.now() + 30_000, next).find((tool) => tool.name === 'alpha__echo');
  if (fresh === undefined) {
    throw new Error('Missing replacement tool');
  }
  expect(textOf(await fresh.execute('mcp-new', { text: 'fresh' }))).toBe('1:fresh');
});

/** One bucket's message, as ingestion would have stored it. */
function seedBatchMessage(
  f: Fixture,
  chat: { readonly chatId: bigint; readonly conversationId: bigint },
  telegramMessageId: number,
  text: string,
  offsetMilliseconds = 0,
): bigint {
  return seedMessage(f.store, chat, {
    telegramMessageId,
    date: new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMilliseconds),
    text,
  });
}

test('a batch released by the stop becomes the continuation instead of a second run', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  const invocationId = queueInvocation(
    f.store,
    chat.conversationId,
    new Date('2026-01-01T00:00:30.000Z').toISOString(),
  );
  const openingBucket = f.store.orm
    .select({ bucketId: invocations.bucketId })
    .from(invocations)
    .where(eq(invocations.id, invocationId))
    .get()!.bucketId;
  // The request the stopped run was answering (its opening batch).
  const earlier = seedBatchMessage(f, chat, 1, 'earlier-request', 1_000);
  f.store.orm
    .insert(bucketMessages)
    .values({ bucketId: openingBucket, messageId: earlier, sequenceNo: 0n, sourceBucketId: openingBucket })
    .run();
  f.scheduler.start();
  await f.whenStarted(1);
  // A batch that arrived while the run was busy is attached but not injected.
  const releasedMessage = seedBatchMessage(f, chat, 2, 'released-message', 2_000);
  const releasedBucket = f.store.orm
    .insert(buckets)
    .values({
      conversationId: chat.conversationId,
      state: 'running',
      kind: 'realtime',
      firstReceivedAt: now(),
      deadlineAt: now(),
      queuedAt: now(),
      startedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: buckets.id })
    .get()!.id;
  f.store.orm
    .insert(bucketMessages)
    .values({ bucketId: releasedBucket, messageId: releasedMessage, sequenceNo: 0n, sourceBucketId: releasedBucket })
    .run();
  f.store.orm
    .insert(invocationBuckets)
    .values({ invocationId, bucketId: releasedBucket, attachedAt: now(), injectedAt: null })
    .run();
  const unknownAudit = startToolCall(f.store.orm, invocationId, 'mcp-unknown', 'alpha__echo', '{}', true);
  finishToolCall(f.store.orm, unknownAudit, 'outcome_unknown', null, 'timeout');

  const result = await f.apply(withChangedAlpha(f.configStore.current().config));

  expect(result.resumedInvocations).toHaveLength(1);
  const followUp = f.store.orm
    .select()
    .from(invocations)
    .where(eq(invocations.id, result.resumedInvocations[0]!))
    .get()!;
  // The released run took over: same conversation, its own batch as opening,
  // and the link back to the stopped run.
  expect(followUp.resumedFromInvocationId).toBe(invocationId);
  expect(followUp.bucketId).toBe(releasedBucket);
  expect(
    f.store.orm.select().from(invocations).where(eq(invocations.conversationId, chat.conversationId)).all(),
  ).toHaveLength(2);

  const rendering = renderInvocationContext(f.store, f.configStore.current().config, followUp.id, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  // (a) the request the stopped run was answering, as history ...
  expect(rendering.userPrompt).toContain('earlier-request');
  expect(rendering.userPrompt).toContain('<untrusted_telegram_history>');
  // ... (b) the MCP-cutover line, including the unresolved tool call ...
  expect(rendering.userPrompt).toContain("The operator changed this chat's MCP configuration");
  expect(rendering.userPrompt).toContain('arrived while the previous run was being stopped');
  expect(rendering.userPrompt).toContain('alpha__echo');
  // ... and (c) the released batch as new messages.
  expect(rendering.userPrompt).toContain('released-message');
  const newMessages = rendering.userPrompt.slice(rendering.userPrompt.indexOf('<untrusted_new_messages>'));
  expect(newMessages).toContain('released-message');
  expect(rendering.userPrompt.indexOf('released-message')).toBeGreaterThan(
    rendering.userPrompt.indexOf('</untrusted_telegram_history>'),
  );
});

test('a task completion the stopped run was handling is rendered again by the continuation', async () => {
  const f = await fixture();
  const chat = seedChat(f.store, BigInt(CHAT_A));
  const invocationId = queueInvocation(
    f.store,
    chat.conversationId,
    new Date('2026-01-01T00:00:30.000Z').toISOString(),
  );
  const openingBucket = f.store.orm
    .select({ bucketId: invocations.bucketId })
    .from(invocations)
    .where(eq(invocations.id, invocationId))
    .get()!.bucketId;
  const task = f.store.orm
    .insert(longTasks)
    .values({
      pluginId: RECURRING_ALARM_PLUGIN_ID,
      conversationId: chat.conversationId,
      payloadJson: JSON.stringify({
        recurring_alarm_id: '7',
        source: 'schedule',
        title: 'Daily standup',
        prompt: 'alarm-prompt',
        time_zone: 'UTC',
        occurrence_at: '2026-01-01T00:00:00.000Z',
        coalesced: 0,
      }),
      state: 'completed',
      deliveryJson: JSON.stringify({ bypassDailyBudget: true }),
      createdAt: now(),
      updatedAt: now(),
      finishedAt: now(),
    })
    .returning({ id: longTasks.id })
    .get()!.id;
  // The stopped run had claimed the occurrence at its opening batch.
  f.store.orm
    .insert(taskReceipts)
    .values({
      taskId: task,
      status: 'completed',
      state: 'handled',
      createdAt: now(),
      updatedAt: now(),
      claimedAt: now(),
      handledAt: now(),
      invocationId,
      bucketId: openingBucket,
      invocationOutcome: 'aborted',
      completionReason: 'aborted',
    })
    .run();
  f.scheduler.start();
  await f.whenStarted(1);

  const result = await f.apply(withChangedAlpha(f.configStore.current().config));

  expect(result.resumedInvocations).toHaveLength(1);
  const followUp = f.store.orm
    .select()
    .from(invocations)
    .where(eq(invocations.id, result.resumedInvocations[0]!))
    .get()!;
  // The receipt's own batch is re-delivered, so the completion has a bucket to
  // render in again.
  expect(followUp.bucketId).toBe(openingBucket);
  expect(f.store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, task)).get()).toMatchObject({
    invocationId: followUp.id,
    bucketId: openingBucket,
    state: 'claimed',
  });
  const rendering = renderInvocationContext(f.store, f.configStore.current().config, followUp.id, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  expect(rendering.userPrompt).toContain('<admin_scheduled_task>');
  expect(rendering.userPrompt).toContain('alarm-prompt');
  expect(rendering.userPrompt).toContain("The operator changed this chat's MCP configuration");
});
