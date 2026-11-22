/**
 * The docs seed's two row-rewriting passes: localization of every human-readable
 * fixture row, and the "healthy instance" normalization the documentation
 * screenshots need. Split from `docs-locale.ts` so each file stays small; both
 * read the same seed text.
 */
import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import {
  agentMessages,
  buckets,
  chats,
  groupMemories,
  invocationMessages,
  invocations,
  longTasks,
  mediaAnalyses,
  memoPadEntries,
  modelCalls,
  senders,
  stickerSets,
  toolCalls,
  warnings,
} from '../../../src/store/schema/index.ts';
import type { AdminSeedResult } from '../../../test/fixtures/admin-seed.ts';
import { T } from '../../../test/fixtures/admin-seed-data.ts';
import type { DocsSeedText } from './docs-locale.ts';

/**
 * Rewrites the human-readable rows `seedAdminFixture`/`seedAdminBulkRows` wrote
 * so the panel never mixes an English placeholder into a Chinese screenshot or
 * the reverse. Ids, timestamps and states stay exactly as seeded: only prose
 * changes, and the rows themselves are read back through the API afterwards.
 */
export function localizeAdminSeed(store: SqliteStore, seed: AdminSeedResult, text: DocsSeedText): void {
  const orm = store.orm;
  orm.update(chats).set({ title: text.chatTitle, username: text.chatUsername }).where(eq(chats.id, T.chat)).run();
  orm.update(senders).set({ displayName: text.senderName }).where(eq(senders.id, T.sender)).run();
  // The two senders `seedAdminBulkRows` adds for the message revisions of the
  // padding rows (5_002 channel, 5_003 member).
  orm.update(senders).set({ displayName: text.channelName }).where(eq(senders.id, 5_002n)).run();
  orm.update(senders).set({ displayName: text.otherSenderName }).where(eq(senders.id, 5_003n)).run();
  orm
    .update(memoPadEntries)
    .set({ summary: text.memories.activeSummary, detail: text.memories.activeDetail })
    .where(eq(memoPadEntries.id, seed.memoryActiveId))
    .run();
  orm
    .update(memoPadEntries)
    .set({ summary: text.memories.expiredSummary, detail: text.memories.expiredSummary })
    .where(eq(memoPadEntries.id, seed.memoryExpiredId))
    .run();
  orm
    .update(groupMemories)
    .set({ summary: text.memories.groupSummary })
    .where(eq(groupMemories.id, seed.groupMemoryId))
    .run();
  // The Sticker sets index prints the analysis the vision model wrote, so the
  // one seamless sticker carries the documentation language as well.
  orm
    .update(mediaAnalyses)
    .set({ description: text.memories.stickerDescription })
    .where(eq(mediaAnalyses.id, T.analysisSticker))
    .run();
  // The set's display title follows the documentation language; its alias and
  // Telegram name are identifiers and stay as seeded.
  orm.update(stickerSets).set({ title: text.memories.stickerSetTitle }).where(eq(stickerSets.id, T.stickerSet)).run();
  const alarm = orm.select().from(longTasks).where(eq(longTasks.id, T.alarm)).get();
  if (alarm !== undefined) {
    // The payload and its timer result carry the summary and the target name.
    const renamePayload = (json: string | null): string | null => {
      if (json === null) {
        return null;
      }
      const value = JSON.parse(json) as Record<string, unknown>;
      if (typeof value.summary === 'string') {
        value.summary = text.memories.alarmSummary;
      }
      if (typeof value.target_display_name === 'string') {
        value.target_display_name = text.senderName;
      }
      return JSON.stringify(value);
    };
    // The delivery policy has its own shape and keeps the mention's name nested;
    // adding a top-level summary there would break the delivery schema.
    const renameDelivery = (json: string | null): string | null => {
      if (json === null) {
        return null;
      }
      const value = JSON.parse(json) as { mentionUser?: { displayName?: unknown } };
      if (typeof value.mentionUser?.displayName === 'string') {
        value.mentionUser.displayName = text.senderName;
      }
      return JSON.stringify(value);
    };
    orm
      .update(longTasks)
      .set({
        payloadJson: renamePayload(alarm.payloadJson) ?? alarm.payloadJson,
        timerResultJson: renamePayload(alarm.timerResultJson),
        deliveryJson: renameDelivery(alarm.deliveryJson) ?? alarm.deliveryJson,
      })
      .where(eq(longTasks.id, T.alarm))
      .run();
  }
}

/**
 * The docs instance is a healthy one.
 *
 * The shared fixture deliberately keeps a failing Invocation and an unread
 * critical warning so the E2E suites can assert on them; a documentation
 * screenshot of a fresh panel would read as a broken deployment. Only the
 * synthetic states change here (rows, ids, timestamps and prose stay as
 * seeded), and only when the docs suite asked for its seeded data.
 */
export function normalizeDocsInstance(store: SqliteStore): void {
  const orm = store.orm;
  // A completed run keeps the completion reason a real successful run stores,
  // so the list and the detail page agree (the seed's failed run says model_error).
  orm
    .update(invocations)
    .set({ state: 'completed', completionReason: 'turn_limit_reached', errorCode: null })
    .where(eq(invocations.state, 'failed'))
    .run();
  orm.update(buckets).set({ state: 'completed', errorCode: null }).where(eq(buckets.state, 'failed')).run();
  // The shared fixture's failed run cannot simply be relabelled: its model call
  // still records a timeout with no response. The docs instance drops the run
  // and its audit rows instead of showing a completed run that failed.
  orm.delete(agentMessages).where(eq(agentMessages.invocationId, T.invocationB)).run();
  orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, T.invocationB)).run();
  orm.delete(toolCalls).where(eq(toolCalls.invocationId, T.invocationB)).run();
  orm.delete(modelCalls).where(eq(modelCalls.invocationId, T.invocationB)).run();
  orm.delete(invocations).where(eq(invocations.id, T.invocationB)).run();
  orm.delete(buckets).where(eq(buckets.id, T.bucketB)).run();
  orm
    .update(warnings)
    .set({ readAt: '2026-09-10T08:02:00.000Z' })
    .where(eq(warnings.code, 'invocation_failure_rate'))
    .run();
  orm
    .update(warnings)
    .set({ readAt: '2026-09-09T07:05:00.000Z' })
    .where(eq(warnings.code, 'admin_login_failures'))
    .run();
}
