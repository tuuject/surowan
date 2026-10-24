import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  buckets,
  conversations,
  hostSends,
  invocationBuckets,
  invocationMessages,
  media,
  messageRevisions,
  messages,
  senders,
  toolCalls,
} from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { writeTestConfig } from './helpers.ts';

/**
 * Bot-send slices: `buildSceneContext` with `beforeSendId` rebuilds only the
 * frozen public input that provably sat between the previous bot message and
 * one successful send of the invocation. These synthetic tests pin that
 * contract — the window, the eligible frozen batches, media/reply isolation and
 * the read-only guarantee — on top of `seedAdminFixture` (its chat,
 * conversation, invocations and send rows) plus rows written here.
 *
 * The Admin seed stores abbreviated snapshots for its rendering pages, while
 * every executed query reads the full writer shape; the seeded frozen rows are
 * therefore replaced by snapshots built from real message / revision / media
 * rows, mirroring `src/store/invocation-snapshot.ts`. Nothing here touches
 * Telegram, a provider or the network.
 */

const CHAT = 1_001n;
export const CONVERSATION = 2_001n;
export const OTHER_CONVERSATION = 2_002n;
export const OPENING_BUCKET = 3_001n;
export const INVOCATION = 4_001n;
export const OTHER_INVOCATION = 4_002n;
export const ALICE = 5_001n;
const BOT_SENDER = 5_002n;
export const MESSAGE_HISTORY = 6_001n; // telegram 900, photo, frozen as history
export const MESSAGE_OPENING = 6_002n; // telegram 901, text, the frozen trigger
const MESSAGE_ANSWER = 6_003n; // telegram 902, the bot's recorded answer to the slice target
export const REVISION_A1 = 6_101n; // photo "first caption", owns the retained media row
export const REVISION_A2 = 6_102n; // photo "edited caption", current revision of 900
export const REVISION_B1 = 6_103n; // text, the frozen snapshot of 901 (reply to 900)
export const REVISION_B2 = 6_104n; // later edit of 901, created after the send started
const REVISION_ANSWER = 6_105n; // the send's own recorded answer
export const REVISION_REFRESH = 6_106n; // a second, newer freeze of 901
export const MEDIA_PHOTO = 6_201n;
export const SEND = 8_101n; // seed send -> telegram 902, created 08:00:03
export const SECOND_SEND = 8_102n;
export const OTHER_SEND = 8_103n;
export const WRONG_CONVERSATION_SEND = 8_105n;
export const FAILED_SEND = 8_106n;
export const NO_MESSAGE_SEND = 8_107n;
export const TARGET_ANSWER = 'the original bot answer';
export const OUTSIDE_QUOTE = 'old answer outside window';

/** Seconds after 07:59:00Z on the fixture day; the send is created at 08:00:03 (at(63)). */
export const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 8, 10, 7, 59, 0) + seconds * 1_000).toISOString();

export interface Fixture {
  readonly config: RawConfig;
  readonly store: SqliteStore;
}

const cleanups: Array<() => Promise<void>> = [];

/** Drops every fixture built by this test file; register it via `afterEach`. */
export async function cleanupFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
}

export async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-scene-slice-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  seedAdminFixture(store);

  // The Admin seed predates the slice contract: its freeze clocks run past the
  // send (which would make its rows unprovable) and its reply copy is not the
  // shape the renderer reads. Fix both before any build.
  store.orm
    .insert(senders)
    .values({
      id: BOT_SENDER,
      telegramType: 'user',
      telegramId: 999n,
      displayName: 'Surowan',
      username: 'surowan_test',
      isBot: true,
      updatedAt: at(30),
    })
    .run();
  store.orm
    .update(messages)
    .set({ receivedAt: at(30) })
    .where(eq(messages.id, MESSAGE_HISTORY))
    .run();
  store.orm
    .update(messages)
    .set({ telegramDate: at(55), receivedAt: at(55) })
    .where(eq(messages.id, MESSAGE_OPENING))
    .run();
  store.orm
    .update(messageRevisions)
    .set({ createdAt: at(55), replySnapshotJson: JSON.stringify({ sender: 'Bot', content: OUTSIDE_QUOTE }) })
    .where(eq(messageRevisions.id, REVISION_B1))
    .run();
  // The selected send's request start is the slice cutoff; delivery finished later.
  store.orm
    .update(hostSends)
    .set({ finishedAt: at(65) })
    .where(eq(hostSends.id, SEND))
    .run();
  // Production records the answered message too; it must never enter its own slice.
  insertMessage(store, {
    id: MESSAGE_ANSWER,
    revisionId: REVISION_ANSWER,
    telegramMessageId: 902n,
    at: at(63),
    text: TARGET_ANSWER,
    sentByBot: true,
  });

  store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  freeze(store, {
    messageId: MESSAGE_HISTORY,
    revisionId: REVISION_A2,
    section: 'history',
    sequenceNo: 1n,
    sourceBucketId: null,
  });
  freeze(store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_B1,
    section: 'new',
    sequenceNo: 2n,
    sourceBucketId: OPENING_BUCKET,
  });
  return { config: loaded.config, store };
}

export interface MessageInput {
  readonly id: bigint;
  /** `null` stores no revision at all (a bare bot-owned row, for example). */
  readonly revisionId: bigint | null;
  readonly telegramMessageId: bigint;
  readonly at: string;
  readonly text?: string | null;
  readonly kind?: string;
  readonly caption?: string | null;
  readonly sentByBot?: boolean;
  readonly visible?: boolean;
  readonly receivedAt?: string;
  readonly replyToMessageId?: bigint | null;
  readonly conversationId?: bigint;
}

/** Inserts one stored message plus its revision, the way ingress or a send records them. */
export function insertMessage(store: SqliteStore, input: MessageInput): void {
  const sentByBot = input.sentByBot ?? false;
  store.orm
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId ?? CONVERSATION,
      chatId: CHAT,
      telegramMessageId: input.telegramMessageId,
      visible: input.visible ?? true,
      sentByBot,
      telegramDate: input.at,
      receivedAt: input.receivedAt ?? input.at,
    })
    .run();
  if (input.revisionId === null) {
    return;
  }
  store.orm
    .insert(messageRevisions)
    .values({
      id: input.revisionId,
      messageId: input.id,
      revisionNo: 1n,
      senderId: sentByBot ? BOT_SENDER : ALICE,
      kind: input.kind ?? 'text',
      text: input.text ?? null,
      caption: input.caption ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: input.at,
      rawFragmentJson: '{}',
    })
    .run();
  store.orm.update(messages).set({ currentRevisionId: input.revisionId }).where(eq(messages.id, input.id)).run();
}

export interface FreezeInput {
  readonly messageId: bigint;
  readonly revisionId: bigint;
  readonly sequenceNo: bigint;
  readonly section?: 'history' | 'new';
  readonly sourceBucketId?: bigint | null;
}

/** Freezes one message into an invocation exactly like the production writer does. */
export function freeze(store: SqliteStore, input: FreezeInput): void {
  store.orm
    .insert(invocationMessages)
    .values({
      invocationId: INVOCATION,
      messageId: input.messageId,
      revisionId: input.revisionId,
      section: input.section ?? 'new',
      sequenceNo: input.sequenceNo,
      sourceBucketId: input.sourceBucketId ?? null,
      snapshotJson: snapshotFor(store, input.messageId, input.revisionId),
    })
    .run();
}

/** Re-freezes an existing row at another revision, for fixtures that start elsewhere. */
export function setFrozenRevision(store: SqliteStore, messageId: bigint, revisionId: bigint): void {
  store.orm
    .update(invocationMessages)
    .set({ revisionId, snapshotJson: snapshotFor(store, messageId, revisionId) })
    .where(and(eq(invocationMessages.invocationId, INVOCATION), eq(invocationMessages.messageId, messageId)))
    .run();
}

/**
 * The full stored snapshot shape (`src/store/invocation-snapshot.ts`), rebuilt
 * from the real message, revision, sender and media rows.
 */
function snapshotFor(store: SqliteStore, messageId: bigint, revisionId: bigint): string {
  const row = store.orm
    .all<{
      telegram_message_id: bigint;
      telegram_date: string;
      sent_by_bot: bigint;
      message_thread_id: bigint;
      revision_no: bigint;
      kind: string;
      text: string | null;
      caption: string | null;
      reply_to_message_id: bigint | null;
      reply_snapshot_json: string | null;
      forward_origin_json: string | null;
      media_group_id: string | null;
      sender_telegram_id: bigint | null;
      sender_display_name: string | null;
      sender_username: string | null;
    }>(
      sql`SELECT m.telegram_message_id, m.telegram_date, m.sent_by_bot, v.message_thread_id,
                 r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                 r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                 s.display_name AS sender_display_name, s.username AS sender_username
          FROM messages m
          JOIN conversations v ON v.id = m.conversation_id
          JOIN message_revisions r ON r.id = ${revisionId} AND r.message_id = m.id
          LEFT JOIN senders s ON s.id = r.sender_id
          WHERE m.id = ${messageId}`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: message revision is missing');
  }
  const mediaRows = store.orm
    .select({
      id: media.id,
      kind: media.kind,
      fileUniqueId: media.fileUniqueId,
      mimeType: media.mimeType,
      width: media.width,
      height: media.height,
    })
    .from(media)
    .where(eq(media.revisionId, revisionId))
    .orderBy(media.id)
    .all();
  return JSON.stringify({
    message_id: row.telegram_message_id.toString(),
    message_thread_id: row.message_thread_id.toString(),
    telegram_date: row.telegram_date,
    sent_by_bot: row.sent_by_bot === 1n,
    revision: row.revision_no.toString(),
    sender: {
      id: row.sender_telegram_id?.toString() ?? null,
      name: row.sender_display_name,
      username: row.sender_username,
    },
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    reply_to_message_id: row.reply_to_message_id?.toString() ?? null,
    reply_snapshot: row.reply_snapshot_json === null ? null : JSON.parse(row.reply_snapshot_json),
    forward_origin: row.forward_origin_json === null ? null : JSON.parse(row.forward_origin_json),
    media_group_id: row.media_group_id,
    media: mediaRows.map((entry) => ({
      id: entry.id.toString(),
      kind: entry.kind,
      file_unique_id: entry.fileUniqueId,
      mime_type: entry.mimeType,
      width: entry.width?.toString() ?? null,
      height: entry.height?.toString() ?? null,
    })),
  });
}

export interface SendInput {
  readonly id: bigint;
  readonly toolCallId: bigint;
  readonly callId: string;
  readonly invocationId: bigint;
  readonly telegramMessageId: bigint | null;
  readonly createdAt: string;
  readonly conversationId?: bigint;
  readonly state?: string;
}

/** Inserts a `send` tool call and its host_sends row. */
export function insertSend(store: SqliteStore, input: SendInput): void {
  store.orm
    .insert(toolCalls)
    .values({
      id: input.toolCallId,
      invocationId: input.invocationId,
      toolCallId: input.callId,
      toolName: 'send',
      argumentsJson: '{}',
      resultText: 'sent',
      state: 'success',
      sideEffect: true,
      errorCode: null,
      durationMs: 1n,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    })
    .run();
  store.orm
    .insert(hostSends)
    .values({
      id: input.id,
      toolCallId: input.toolCallId,
      conversationId: input.conversationId ?? CONVERSATION,
      kind: 'text',
      requestJson: '{}',
      state: input.state ?? 'success',
      telegramMessageId: input.telegramMessageId,
      responseJson: input.telegramMessageId === null ? null : `{"message_id":${input.telegramMessageId}}`,
      errorCode: null,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    })
    .run();
}

export function insertBucket(store: SqliteStore, id: bigint): void {
  store.orm
    .insert(buckets)
    .values({
      id,
      conversationId: CONVERSATION,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: at(0),
      deadlineAt: at(15),
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

/** Attaches a bucket the way the queue does; `injectedAt: null` means never injected. */
export function attachBucket(store: SqliteStore, bucketId: bigint, injectedAt: string | null): void {
  store.orm
    .insert(invocationBuckets)
    .values({ invocationId: INVOCATION, bucketId, attachedAt: at(40), injectedAt })
    .run();
}

export function insertOtherConversation(store: SqliteStore): void {
  store.orm
    .insert(conversations)
    .values({ id: OTHER_CONVERSATION, chatId: CHAT, messageThreadId: 7n, createdAt: at(0), updatedAt: at(0) })
    .run();
}
