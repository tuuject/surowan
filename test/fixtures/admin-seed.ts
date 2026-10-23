import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { seedAdminAlarmsAndMemories, seedAdminContexts, seedAdminDailyUsage } from './admin-seed-context.ts';
import { seedAdminConversation, seedAdminMessages, seedAdminStickers } from './admin-seed-conversation.ts';
import { T } from './admin-seed-data.ts';
import {
  seedAdminBuckets,
  seedAdminFrozenContext,
  seedAdminModelCalls,
  seedAdminToolCalls,
  seedAdminTranscript,
} from './admin-seed-invocation.ts';

/**
 * Synthetic admin-panel fixture data (backend only, no React). The Playwright
 * E2E server (`apps/admin-next/e2e/server.ts`) writes this into a fresh
 * SqliteStore so every list and detail page has representative rows:
 *
 * - two invocations: one completed (with a `send` tool call + linked
 *   host_sends row, retained/new context messages, an oversized request
 *   payload) and one failed (with a failed model call carrying a redacted
 *   error detail);
 * - messages with revisions and media, sticker sets/analyses, a pending
 *   alarm, active + expired memories, a conversation context with messages
 *   (one payload above the admin preview cap, so the truncated marker shows)
 *   and a capability ref, and daily usage rows.
 *
 * All row IDs are deterministic bigints so tests can assert on them. Do not
 * wire this into any production code path.
 */

export interface AdminSeedResult {
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly bucketA: bigint;
  readonly bucketB: bigint;
  readonly invocationA: bigint;
  readonly invocationB: bigint;
  readonly messageIds: readonly bigint[];
  readonly stickerSetId: bigint;
  readonly alarmId: bigint;
  readonly memoryActiveId: string;
  readonly memoryExpiredId: string;
  readonly contextId: bigint;
}

export function seedAdminFixture(store: SqliteStore): AdminSeedResult {
  const orm = store.orm;

  seedAdminConversation(orm);
  seedAdminMessages(orm);
  seedAdminBuckets(orm);
  seedAdminModelCalls(orm);
  seedAdminToolCalls(orm);
  seedAdminTranscript(orm);
  seedAdminFrozenContext(orm);
  seedAdminStickers(orm);
  const memoryIds = seedAdminAlarmsAndMemories(orm);
  seedAdminContexts(orm);
  seedAdminDailyUsage(orm);

  return {
    chatId: T.chat,
    conversationId: T.conversation,
    bucketA: T.bucketA,
    bucketB: T.bucketB,
    invocationA: T.invocationA,
    invocationB: T.invocationB,
    messageIds: [T.messageA, T.messageB],
    stickerSetId: T.stickerSet,
    alarmId: T.alarm,
    memoryActiveId: memoryIds.memoryActiveId,
    memoryExpiredId: memoryIds.memoryExpiredId,
    contextId: T.context,
  };
}
