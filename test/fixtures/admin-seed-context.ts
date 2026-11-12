import { eq } from 'drizzle-orm';
import type { Orm } from '../../src/store/store.ts';
import {
  contextMessages,
  contextRefs,
  conversationContexts,
  dailyUsage,
  groupMemories,
  groupMemoryLanes,
  groupMemoryRuns,
  memoPadEntries,
  warnings,
} from '../../src/store/schema/index.ts';
import { AT, insertAlarmTask, LONG_CONTEXT_PAYLOAD_JSON, T } from './admin-seed-data.ts';

/**
 * Context-side rows: the pending alarm task with its active and expired
 * memories, the conversation context with messages and a capability ref, and
 * the daily usage counters behind the Overview and Usage charts.
 */

/** Ids of the active and expired memory rows (both pattern-valid `mem_` + 32 hex). */
export interface AdminSeedMemories {
  readonly memoryActiveId: string;
  readonly memoryExpiredId: string;
}

/** Alarm task (pending) + memories (active + expired). */
export function seedAdminAlarmsAndMemories(orm: Orm): AdminSeedMemories {
  insertAlarmTask(orm, {
    id: T.alarm,
    conversationId: T.conversation,
    targetUserId: 42n,
    summary: 'Remind Alice about the fixture data',
    scheduledAt: '2026-09-10T20:00:00.000Z',
    createdAt: '2026-09-10T08:00:11.000Z',
    createdByInvocationId: T.invocationA,
    updatedAt: '2026-09-10T08:00:11.000Z',
  });

  const memoryActiveId = 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  orm
    .insert(memoPadEntries)
    .values({
      id: memoryActiveId,
      chatId: T.chat,
      summary: 'Alice prefers short replies.',
      detail: 'Alice prefers short replies.',
      createdAt: '2026-09-10T08:00:12.000Z',
      // Must stay active regardless of when the fixture runs: a fixed date
      // silently aged into "expired" and broke the state=expired filter E2E.
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      updatedAt: '2026-09-10T08:00:12.000Z',
    })
    .run();
  const memoryExpiredId = 'mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  orm
    .insert(memoPadEntries)
    .values({
      id: memoryExpiredId,
      chatId: T.chat,
      summary: 'Old note that expired already.',
      detail: 'Old note that expired already.',
      createdAt: '2026-09-01T08:00:12.000Z',
      expiresAt: '2026-09-05T08:00:12.000Z',
      updatedAt: '2026-09-01T08:00:12.000Z',
    })
    .run();

  return { memoryActiveId, memoryExpiredId };
}

/** One unread runtime warning and one already-read security warning (Warnings page). */
export function seedAdminWarnings(orm: Orm): void {
  orm
    .insert(warnings)
    .values({
      code: 'invocation_failure_rate',
      severity: 'critical',
      variablesJson: JSON.stringify({
        failed: 51,
        total: 100,
        failure_rate: 0.51,
        threshold: 0.5,
        sample_size: 100,
        last_failed_at: '2026-09-10T08:00:20.000Z',
      }),
      createdAt: '2026-09-10T08:01:00.000Z',
      updatedAt: '2026-09-10T08:01:00.000Z',
      readAt: null,
    })
    .run();
  orm
    .insert(warnings)
    .values({
      code: 'admin_login_failures',
      severity: 'warning',
      variablesJson: JSON.stringify({
        consecutive_failures: 5,
        threshold: 5,
        last_failed_at: '2026-09-09T07:00:00.000Z',
      }),
      createdAt: '2026-09-09T07:00:01.000Z',
      updatedAt: '2026-09-09T07:00:01.000Z',
      readAt: '2026-09-09T07:05:00.000Z',
    })
    .run();
}

/** One generated group memory over the seeded messages (Group memory page). */
export const ADMIN_GROUP_MEMORY_ID = 'gmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export function seedAdminGroupMemories(orm: Orm): string {
  orm
    .insert(groupMemories)
    .values({
      id: ADMIN_GROUP_MEMORY_ID,
      chatId: T.chat,
      day: '2026-09-10',
      summary: 'Alice discussed the fixture data.',
      firstMessageId: 900n,
      lastMessageId: 901n,
      createdAt: '2026-09-10T08:05:00.000Z',
    })
    .run();
  // The live lane read message 900, then failed twice on the next batch; the
  // progress panel shows it as failing with the later messages still pending.
  orm
    .insert(groupMemoryLanes)
    .values({
      chatId: T.chat,
      lane: 'live',
      throughMessageId: 900n,
      state: 'idle',
      lastAttemptAt: '2026-09-10T08:40:00.000Z',
      lastSuccessAt: '2026-09-10T08:05:00.000Z',
      nextAttemptAt: '2026-09-10T09:10:00.000Z',
      errorCode: 'group_memory_invalid_output',
      consecutiveFailures: 2n,
      createdAt: '2026-09-10T08:00:00.000Z',
      updatedAt: '2026-09-10T08:40:00.000Z',
    })
    .run();
  orm
    .insert(groupMemoryRuns)
    .values([
      {
        chatId: T.chat,
        lane: 'live',
        day: '2026-09-10',
        firstMessageId: 900n,
        throughMessageId: 900n,
        messages: 1n,
        state: 'success',
        events: 1n,
        modelCalls: 1n,
        startedAt: '2026-09-10T08:04:00.000Z',
        finishedAt: '2026-09-10T08:05:00.000Z',
      },
      {
        chatId: T.chat,
        lane: 'live',
        day: '2026-09-10',
        firstMessageId: 901n,
        throughMessageId: 902n,
        messages: 2n,
        state: 'error',
        modelCalls: 2n,
        errorCode: 'group_memory_invalid_output',
        errorDetail: 'The tool model returned invalid JSON',
        startedAt: '2026-09-10T08:39:00.000Z',
        finishedAt: '2026-09-10T08:40:00.000Z',
      },
    ])
    .run();
  return ADMIN_GROUP_MEMORY_ID;
}

/** Conversation context + messages + capability ref (Contexts page). */
export function seedAdminContexts(orm: Orm): void {
  orm
    .insert(conversationContexts)
    .values({
      id: T.context,
      conversationId: T.conversation,
      headSeq: 1n,
      nextSeq: 4n,
      sendCountTotal: 1n,
      systemPromptHash: 'seed-system-prompt-hash',
      activeInvocationId: null,
      lastActiveAt: '2026-09-10T08:00:06.000Z',
      lastGcAt: null,
      createdAt: '2026-09-10T07:59:30.000Z',
      updatedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 1n,
      role: 'user',
      payloadJson: JSON.stringify({ text: 'edited caption' }),
      invocationId: T.invocationA,
      isCheckpoint: true,
      sendSeq: null,
      estTokens: 20n,
      evictedAt: null,
      createdAt: '2026-09-10T07:59:30.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 2n,
      role: 'assistant',
      payloadJson: JSON.stringify({ text: 'private reasoning before calling read' }),
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: null,
      estTokens: 30n,
      evictedAt: null,
      createdAt: '2026-09-10T07:59:46.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 3n,
      role: 'assistant',
      payloadJson: JSON.stringify({ text: 'Hello from the seeded invocation', send: true }),
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: 1n,
      estTokens: 25n,
      evictedAt: null,
      createdAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
  // Seq 4 carries a payload above the admin API preview cap so the detail
  // page's `payload_truncated` marker is exercised by test/admin/admin.test.ts.
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 4n,
      role: 'user',
      payloadJson: LONG_CONTEXT_PAYLOAD_JSON,
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: null,
      estTokens: 60n,
      evictedAt: null,
      createdAt: '2026-09-10T08:05:00.000Z',
    })
    .run();
  orm.update(conversationContexts).set({ nextSeq: 5n }).where(eq(conversationContexts.id, T.context)).run();
  orm
    .insert(contextRefs)
    .values({
      contextId: T.context,
      ref: 'img:unique_photo_seed_1',
      kind: 'media',
      sourceSeq: 1n,
      mediaId: T.mediaPhoto,
      stickerFileId: null,
      targetConversationId: null,
      targetThreadId: null,
      expiresAt: '2026-09-13T08:00:03.000Z',
      createdAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
}

/** Daily usage (Overview / Usage charts). */
export function seedAdminDailyUsage(orm: Orm): void {
  const usageRows: readonly (readonly [string, string, string, string, bigint])[] = [
    ['2026-09-13', 'global', 'agent_model', 'tokens', 12_000n],
    ['2026-09-13', 'global', 'agent_model', 'invocations', 4n],
    ['2026-09-13', 'global', 'tools', 'tool_calls', 9n],
    ['2026-09-14', 'global', 'agent_model', 'tokens', 8_000n],
    ['2026-09-14', 'global', 'agent_model', 'invocations', 2n],
    ['2026-09-14', 'global', 'tools', 'tool_calls', 5n],
  ];
  for (const [utcDate, scope, resource, metric, amount] of usageRows) {
    orm
      .insert(dailyUsage)
      .values({
        utcDate,
        scope,
        resource,
        metric,
        amount,
        updatedAt: AT,
      })
      .run();
  }
}
