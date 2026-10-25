import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  buckets,
  conversationContexts,
  conversations,
  dailyUsage,
  invocations,
  memories,
  messageRevisions,
  messages,
  senders,
  stickers,
} from '../../src/store/schema/index.ts';
import { AT, insertAlarmTask, T } from './admin-seed-data.ts';

/**
 * Bulk rows for the Playwright E2E suite. Every cursor list needs more
 * than `PAGE_SIZE` (25) rows so "Load more" appears and actually fetches the
 * next page against the real backend:
 *
 * - 28 extra invocations (+28 buckets), ids 4_100..4_127;
 * - 28 extra messages (+1 revision each), ids 6_100..6_127, text
 *   `e2e message N` (searchable);
 * - 26 extra conversations (+26 conversation contexts), ids 2_100..2_125 /
 *   11_100..11_125, `last_active_at` newer than the base fixture;
 * - 26 extra pending alarms (10_100..10_125, `e2e alarm N`) plus one
 *   pre-cancelled alarm (10_200) for the state filter;
 * - 28 extra active memories with pattern-valid ids (`mem_` + 32 hex) so the
 *   memory cursor passes `MEMORY_ID_PATTERN`;
 * - 28 extra stickers across the two seeded sets with searchable emoji.
 *
 * Returns the ids the E2E specs need to address specific rows (conflict
 * alarm, searchable message, paginated lists). Do not wire this into any
 * production code path.
 */
export interface AdminBulkSeedIds {
  readonly invocationStart: bigint;
  readonly invocationCount: number;
  readonly messageStart: bigint;
  readonly messageCount: number;
  readonly contextConversationStart: bigint;
  readonly contextCount: number;
  readonly alarmStart: bigint;
  readonly alarmCount: number;
  readonly cancelledAlarmId: bigint;
  readonly stickerStart: bigint;
  readonly stickerCount: number;
  /** id of the first extra memory (`mem_` + 32 hex). */
  readonly memoryFirstId: string;
}

const BULK_BASE = '2026-09-11T08:00:00.000Z';
const EXTRA_INVOCATIONS = 28;
const EXTRA_MESSAGES = 28;
const EXTRA_CONTEXTS = 26;
const EXTRA_ALARMS = 26;
const EXTRA_STICKERS = 28;
const EXTRA_MEMORIES = 28;

export function seedAdminBulkRows(store: SqliteStore): AdminBulkSeedIds {
  const orm = store.orm;
  const iso = (offsetMinutes: number): string => new Date(Date.parse(BULK_BASE) + offsetMinutes * 60_000).toISOString();
  orm
    .insert(senders)
    .values([
      {
        id: 5_002n,
        telegramType: 'sender_chat',
        telegramId: -1009876543210n,
        displayName: 'Anonymous channel',
        username: null,
        isBot: false,
        updatedAt: AT,
      },
      {
        id: 5_003n,
        telegramType: 'user',
        telegramId: 43n,
        displayName: 'Bob',
        username: null,
        isBot: false,
        updatedAt: AT,
      },
    ])
    .run();

  // --- 28 buckets + 28 invocations (24 completed / 4 failed) ---
  for (let index = 0; index < EXTRA_INVOCATIONS; index += 1) {
    const bucketId = 3_100n + BigInt(index);
    const invocationId = 4_100n + BigInt(index);
    const offset = index * 2;
    const failed = index >= EXTRA_INVOCATIONS - 4;
    orm
      .insert(buckets)
      .values({
        id: bucketId,
        conversationId: T.conversation,
        state: failed ? 'failed' : 'completed',
        kind: 'realtime',
        firstReceivedAt: iso(offset),
        deadlineAt: iso(offset + 1),
        queuedAt: iso(offset + 1),
        startedAt: iso(offset + 1),
        finishedAt: iso(offset + 2),
        errorCode: failed ? 'model_failed' : null,
        createdAt: iso(offset),
        updatedAt: iso(offset + 2),
      })
      .run();
    orm
      .insert(invocations)
      .values({
        id: invocationId,
        bucketId,
        conversationId: T.conversation,
        state: failed ? 'failed' : 'completed',
        configHash: `seed-e2e-config-hash-${index}`,
        promptVersion: 7n,
        toolRegistryHash: null,
        toolRegistryJson: null,
        startedAt: iso(offset + 1),
        finishedAt: iso(offset + 2),
        completionReason: failed ? 'model_error' : 'turn_limit_reached',
        errorCode: failed ? 'model_failed' : null,
        sendsUsed: 0n,
        toolCallsUsed: 0n,
        turnsUsed: 1n,
        sideEffectStarted: false,
        createdAt: iso(offset),
      })
      .run();
  }

  // --- 28 messages, each with one text revision (`e2e message N`) ---
  for (let index = 0; index < EXTRA_MESSAGES; index += 1) {
    const messageId = 6_100n + BigInt(index);
    const revisionId = 6_300n + BigInt(index);
    const offset = index + 30;
    orm
      .insert(messages)
      .values({
        id: messageId,
        conversationId: T.conversation,
        chatId: T.chat,
        telegramMessageId: 1_000n + BigInt(index),
        currentRevisionId: null,
        visible: true,
        sentByBot: false,
        telegramDate: iso(offset),
        receivedAt: iso(offset),
      })
      .run();
    orm
      .insert(messageRevisions)
      .values({
        id: revisionId,
        messageId,
        revisionNo: 1n,
        senderId: index === 25 ? 5_003n : index === 26 ? 5_002n : index === 27 ? null : T.sender,
        kind: 'text',
        text: `e2e message ${index + 1}`,
        caption: null,
        replyToMessageId: null,
        replySnapshotJson: null,
        forwardOriginJson: null,
        mediaGroupId: null,
        serviceJson: null,
        createdAt: iso(offset),
        rawFragmentJson: '{}',
      })
      .run();
    orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  }

  // --- 26 extra conversations + contexts, newest `last_active_at` ---
  for (let index = 0; index < EXTRA_CONTEXTS; index += 1) {
    const conversationId = 2_100n + BigInt(index);
    const contextId = 11_100n + BigInt(index);
    const offset = index + 10;
    orm
      .insert(conversations)
      .values({
        id: conversationId,
        chatId: T.chat,
        messageThreadId: BigInt(100 + index),
        createdAt: iso(offset),
        updatedAt: iso(offset),
      })
      .run();
    orm
      .insert(conversationContexts)
      .values({
        id: contextId,
        conversationId,
        headSeq: 1n,
        nextSeq: 1n,
        sendCountTotal: 0n,
        systemPromptHash: 'seed-e2e-context-hash',
        activeInvocationId: null,
        lastActiveAt: iso(offset),
        lastGcAt: null,
        createdAt: iso(offset),
        updatedAt: iso(offset),
      })
      .run();
  }

  // --- 26 pending alarm tasks + 1 pre-cancelled task ---
  for (let index = 0; index < EXTRA_ALARMS; index += 1) {
    const alarmId = 10_100n + BigInt(index);
    const scheduled = iso(index + 20);
    insertAlarmTask(orm, {
      id: alarmId,
      conversationId: T.conversation,
      targetUserId: 42n,
      summary: `e2e alarm ${index + 1}`,
      scheduledAt: scheduled,
      createdAt: BULK_BASE,
      updatedAt: scheduled,
    });
  }
  insertAlarmTask(orm, {
    id: 10_200n,
    conversationId: T.conversation,
    targetUserId: 42n,
    summary: 'e2e alarm already cancelled',
    scheduledAt: '2026-09-11T10:00:00.000Z',
    createdAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-11T09:00:00.000Z',
    state: 'cancelled',
    cancelledAt: '2026-09-11T09:00:00.000Z',
    cancelledBy: 'admin-panel',
  });

  // --- 28 active memories with pattern-valid ids (`mem_` + 32 hex) ---
  const memoryFirstId = `mem_${'0'.repeat(31)}1`;
  // Must stay active regardless of when the fixture runs, for the same reason
  // as `memoryActiveId` in `admin-seed-context.ts`: a fixed date silently aged
  // into "expired" and broke the state=expired filter E2E.
  const bulkMemoryExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  for (let index = 0; index < EXTRA_MEMORIES; index += 1) {
    const id = `mem_${String(index + 1).padStart(32, '0')}`;
    orm
      .insert(memories)
      .values({
        id,
        conversationId: T.conversation,
        content: `e2e memory ${index + 1}`,
        createdAt: iso(index),
        expiresAt: bulkMemoryExpiresAt,
        updatedAt: iso(index),
      })
      .run();
  }

  // --- 28 extra stickers: 16 on `mascot` (14 success / 2 error), 12 on `legacy` ---
  for (let index = 0; index < EXTRA_STICKERS; index += 1) {
    const stickerId = 9_300n + BigInt(index);
    const onMascot = index < 16;
    const failed = index >= 14 && index < 16;
    orm
      .insert(stickers)
      .values({
        id: stickerId,
        stickerSetId: onMascot ? T.stickerSet : T.stickerSetLegacy,
        fileUniqueId: `e2e_sticker_${index + 1}`,
        fileId: `file_e2e_sticker_${index + 1}`,
        emoji: `e2e-${index + 1}`,
        format: 'static',
        thumbnailJson: null,
        active: true,
        currentAnalysisId: null,
        indexState: failed ? 'error' : 'success',
        failureCount: failed ? 1n : 0n,
        nextRetryAt: failed ? '2026-09-12T08:00:10.000Z' : null,
        updatedAt: iso(index),
      })
      .run();
  }

  // --- one today-relative usage row so Overview's "Today's usage" is non-empty ---
  const today = new Date().toISOString().slice(0, 10);
  orm
    .insert(dailyUsage)
    .values({
      utcDate: today,
      scope: 'global',
      resource: 'agent_model',
      metric: 'model_tokens',
      amount: 1_000n,
      updatedAt: new Date().toISOString(),
    })
    .run();

  return {
    invocationStart: 4_100n,
    invocationCount: EXTRA_INVOCATIONS,
    messageStart: 6_100n,
    messageCount: EXTRA_MESSAGES,
    contextConversationStart: 2_100n,
    contextCount: EXTRA_CONTEXTS,
    alarmStart: 10_100n,
    alarmCount: EXTRA_ALARMS,
    cancelledAlarmId: 10_200n,
    stickerStart: 9_300n,
    stickerCount: EXTRA_STICKERS,
    memoryFirstId,
  };
}
