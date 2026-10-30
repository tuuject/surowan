/**
 * Row and message shapes one historical scene reads, plus the loaders for its
 * source invocation, its frozen opening batch and the replay-slice window.
 *
 * Split out of `scene-context.ts`; the store queries, their order and the
 * validation they perform are unchanged.
 */

import { sql } from 'drizzle-orm';
import type { BusinessStore } from '../../store/store.ts';

import {
  MEDIA_MISSING,
  MEDIA_UNAVAILABLE,
  missingMediaIds,
  renderHistoryRows,
  storedSnapshotValidator,
  type StoredSnapshot,
} from './render.ts';
import type { PreparedSnapshot } from '../builder/schema.ts';

export class SceneSliceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SceneSource {
  readonly bucketId: bigint;
  readonly bucketKind: string;
  readonly conversationId: bigint;
  readonly createdAt: string;
  readonly threadId: bigint;
  readonly chatId: bigint;
}

/** One rendered message plus the media rows it references, for statistics. */
export interface SceneMessage {
  snapshot: PreparedSnapshot;
  readonly mediaIds: readonly bigint[];
}

interface OpeningRow {
  readonly snapshot_json: string;
  readonly revision_id: bigint | null;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
}

export interface HistoryRow {
  readonly message_id: bigint;
  readonly snapshot_json: string | null;
  readonly frozen_revision_id: bigint | null;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly sent_by_bot: bigint;
  readonly revision_id: bigint | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly raw_fragment_json: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
}

export interface HistoryMediaRow {
  readonly revision_id: bigint;
  readonly id: bigint;
  readonly kind: string;
  readonly mime_type: string | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
}

interface BotSlice {
  readonly sendId: bigint;
  readonly messageId: bigint;
  readonly previousMessageId: bigint | null;
  /** Request start, not delivery completion: later arrivals cannot influence this answer. */
  readonly cutoffAt: string;
}

export function loadSource(store: BusinessStore, invocationId: bigint): SceneSource {
  const source = store.orm
    .all<{
      bucket_id: bigint;
      bucket_kind: string;
      conversation_id: bigint;
      created_at: string;
      message_thread_id: bigint;
      telegram_chat_id: bigint;
    }>(
      sql`SELECT i.bucket_id, i.conversation_id, i.created_at, b.kind AS bucket_kind,
                 v.message_thread_id, c.telegram_chat_id
          FROM invocations i
          JOIN buckets b ON b.id = i.bucket_id
          JOIN conversations v ON v.id = i.conversation_id
          JOIN chats c ON c.id = v.chat_id
          WHERE i.id = ${invocationId}`,
    )
    .at(0);
  if (source === undefined) {
    throw new Error(`Scene context: invocation ${invocationId} does not exist`);
  }
  return {
    bucketId: source.bucket_id,
    bucketKind: source.bucket_kind,
    conversationId: source.conversation_id,
    createdAt: source.created_at,
    threadId: source.message_thread_id,
    chatId: source.telegram_chat_id,
  };
}

/**
 * The opening bucket's frozen `new` rows. Current writers tag every row with its
 * bucket; rows without a tag are accepted as opening only for invocations that
 * never attached another bucket, so a legacy NULL batch can be used while a
 * modern attach can never leak through.
 */
export function loadOpeningBatch(store: BusinessStore, invocationId: bigint, source: SceneSource): SceneMessage[] {
  const rows = store.orm.all<OpeningRow>(
    sql`SELECT im.snapshot_json, r.id AS revision_id, m.telegram_message_id, m.telegram_date
        FROM invocation_messages im
        JOIN messages m ON m.id = im.message_id
        LEFT JOIN message_revisions r ON r.id = im.revision_id AND r.message_id = m.id
        WHERE im.invocation_id = ${invocationId}
          AND im.section = 'new'
          AND m.conversation_id = ${source.conversationId}
          AND (im.source_bucket_id = ${source.bucketId} OR (
            im.source_bucket_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM invocation_buckets ib
              WHERE ib.invocation_id = im.invocation_id AND ib.bucket_id <> ${source.bucketId}
            )
          ))
        ORDER BY im.sequence_no`,
  );
  const parsed: StoredSnapshot[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.snapshot_json);
    } catch {
      throw new Error(`Scene context: invocation ${invocationId} contains an invalid message snapshot`);
    }
    if (
      !storedSnapshotValidator.Check(value) ||
      value.message_id !== row.telegram_message_id.toString() ||
      value.telegram_date !== row.telegram_date ||
      (value.message_thread_id !== undefined && value.message_thread_id !== source.threadId.toString())
    ) {
      throw new Error(`Scene context: invocation ${invocationId} contains an unexpected message snapshot`);
    }
    parsed.push(value);
  }
  return parsed.map((snapshot, index) => {
    const row = rows[index];
    if (row === undefined || row.revision_id === null) {
      throw new Error(`Scene context: invocation ${invocationId} contains an invalid revision snapshot`);
    }
    const missing = missingMediaIds(
      store,
      snapshot.media.map((entry) => BigInt(entry.id)),
      row.revision_id,
    );
    return {
      snapshot: {
        message_id: snapshot.message_id,
        ...(snapshot.message_thread_id === undefined ? {} : { message_thread_id: snapshot.message_thread_id }),
        telegram_date: snapshot.telegram_date,
        sent_by_bot: snapshot.sent_by_bot,
        sender: snapshot.sender,
        kind: snapshot.kind,
        text: snapshot.text,
        caption: snapshot.caption,
        ...(snapshot.spoilers === undefined ? {} : { spoilers: snapshot.spoilers }),
        ...(snapshot.media_slots === undefined ? {} : { media_slots: snapshot.media_slots }),
        reply_to_message_id: snapshot.reply_to_message_id,
        reply_snapshot: snapshot.reply_snapshot,
        forward_origin: snapshot.forward_origin,
        media_group_id: snapshot.media_group_id,
        media: snapshot.media.map((entry) => ({
          // Only retained media belonging to this frozen revision can receive
          // an ephemeral reference when the scene supports image input.
          image_ref: missing.has(BigInt(entry.id)) ? MEDIA_MISSING : MEDIA_UNAVAILABLE,
          kind: entry.kind,
          mime_type: entry.mime_type,
          width: entry.width,
          height: entry.height,
        })),
      },
      mediaIds: snapshot.media.map((entry) => BigInt(entry.id)),
    };
  });
}

export function loadBotSlice(
  store: BusinessStore,
  invocationId: bigint,
  source: SceneSource,
  sendId: bigint,
): BotSlice {
  const target = store.orm
    .all<{ message_id: bigint; cutoff_at: string }>(
      sql`SELECT ts.telegram_message_id AS message_id, ts.created_at AS cutoff_at
        FROM host_sends ts JOIN tool_calls tc ON tc.id = ts.tool_call_id
        WHERE ts.id = ${sendId} AND tc.invocation_id = ${invocationId}
          AND ts.conversation_id = ${source.conversationId}
          AND ts.state = 'success' AND ts.telegram_message_id IS NOT NULL`,
    )
    .at(0);
  if (target === undefined) {
    throw new SceneSliceError(
      'replay_slice_target_invalid',
      'Slice target must be a retained successful send from this invocation',
    );
  }
  const previous = store.orm
    .all<{ message_id: bigint }>(
      sql`SELECT MAX(message_id) AS message_id FROM (
          SELECT telegram_message_id AS message_id FROM messages
          WHERE conversation_id = ${source.conversationId} AND sent_by_bot = 1
            AND telegram_message_id < ${target.message_id}
          UNION ALL
          SELECT telegram_message_id AS message_id FROM host_sends
          WHERE conversation_id = ${source.conversationId} AND state = 'success'
            AND telegram_message_id < ${target.message_id}
        )`,
    )
    .at(0);
  return {
    sendId,
    messageId: target.message_id,
    previousMessageId: previous?.message_id ?? null,
    cutoffAt: target.cutoff_at,
  };
}

/** Only frozen public inputs known before the selected send; all batches enter immediately. */
export function loadSliceBatch(
  store: BusinessStore,
  invocationId: bigint,
  source: SceneSource,
  slice: BotSlice,
): SceneMessage[] {
  const rows = store.orm.all<HistoryRow>(
    sql`WITH eligible AS (
          SELECT im.* FROM invocation_messages im
          JOIN message_revisions known ON known.id = im.revision_id AND known.message_id = im.message_id
          WHERE im.invocation_id = ${invocationId} AND known.created_at <= ${slice.cutoffAt}
            AND im.section IN ('history', 'new') AND (
            im.section = 'history' OR im.source_bucket_id = ${source.bucketId} OR
            (im.source_bucket_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM invocation_buckets ib WHERE ib.invocation_id = im.invocation_id
                AND ib.bucket_id <> ${source.bucketId}
            )) OR EXISTS (
              SELECT 1 FROM invocation_buckets ib WHERE ib.invocation_id = im.invocation_id
                AND ib.bucket_id = im.source_bucket_id AND ib.injected_at < ${slice.cutoffAt}
            )
          )
        )
        SELECT m.id AS message_id, im.snapshot_json, r.id AS frozen_revision_id,
               m.telegram_message_id, m.telegram_date, m.sent_by_bot,
               r.id AS revision_id, r.kind, r.text, r.caption, r.raw_fragment_json, r.reply_to_message_id,
               r.reply_snapshot_json, r.forward_origin_json, r.media_group_id,
               s.telegram_id AS sender_telegram_id, s.display_name AS sender_display_name, s.username AS sender_username
        FROM eligible im JOIN messages m ON m.id = im.message_id
        LEFT JOIN message_revisions r ON r.id = im.revision_id AND r.message_id = m.id
        LEFT JOIN senders s ON s.id = r.sender_id
        WHERE m.conversation_id = ${source.conversationId} AND m.visible = 1 AND m.sent_by_bot = 0
          AND m.received_at <= ${slice.cutoffAt}
          AND m.telegram_message_id > ${slice.previousMessageId ?? -1n}
          AND m.telegram_message_id < ${slice.messageId}
          AND m.telegram_message_id > COALESCE(
            (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = ${source.conversationId}), -1)
          AND NOT EXISTS (SELECT 1 FROM eligible newer WHERE newer.message_id = im.message_id
            AND newer.sequence_no > im.sequence_no)
        ORDER BY m.telegram_date DESC, m.telegram_message_id DESC`,
  );
  if (rows.length === 0) {
    throw new SceneSliceError('replay_slice_empty', 'No retained public input exists between these bot messages');
  }
  return [...renderHistoryRows(store, rows, source).newestFirst].reverse();
}
