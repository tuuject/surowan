/**
 * Turns stored history rows into rendered scene messages: the history-window
 * query, snapshot and media decoding, the comparator and the clock line.
 *
 * Split out of `scene-context.ts`. It only reads rows; the canonical history
 * rules are untouched — no Context header or state is re-read or copied here.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Static } from 'typebox';
import Compile from 'typebox/compile';
import type { RawConfig } from '../../platform/config/index.ts';
import { bodyFromFragment } from '../../platform/telegram-markdown/index.ts';
import { media } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';

import type { HistoryMediaRow, HistoryRow, SceneMessage, SceneSource } from './rows.ts';
import { MessageSnapshotSchema } from '../builder/schema.ts';
import type { PreparedSnapshot } from '../builder/schema.ts';

export const storedSnapshotValidator = Compile(MessageSnapshotSchema);
export type StoredSnapshot = Static<typeof MessageSnapshotSchema>;

export const MEDIA_UNAVAILABLE = 'media_unavailable';
export const MEDIA_MISSING = 'media_missing';

/**
 * The newest `agent.history_messages` messages of the conversation that were
 * provably visible at the cutoff. Each message contributes the newest revision
 * created no later than the cutoff; a message whose provable revision is gone
 * is dropped and counted. Frozen history takes precedence over the fallback,
 * and all opening/attached messages are excluded from this history window.
 */
export function loadHistoryWindow(
  store: BusinessStore,
  invocationId: bigint,
  source: SceneSource,
  config: RawConfig,
  last: PreparedSnapshot,
): { readonly newestFirst: readonly SceneMessage[]; readonly missing: number } {
  const rows = store.orm.all<HistoryRow>(
    sql`SELECT m.id AS message_id, im.snapshot_json, frozen.id AS frozen_revision_id,
               m.telegram_message_id, m.telegram_date, m.sent_by_bot,
               r.id AS revision_id, r.kind, r.text, r.caption, r.raw_fragment_json, r.reply_to_message_id,
               r.reply_snapshot_json, r.forward_origin_json, r.media_group_id,
               s.telegram_id AS sender_telegram_id, s.display_name AS sender_display_name, s.username AS sender_username
        FROM messages m
        LEFT JOIN invocation_messages im ON im.message_id = m.id
          AND im.invocation_id = ${invocationId} AND im.section = 'history'
        LEFT JOIN message_revisions frozen ON frozen.id = im.revision_id AND frozen.message_id = m.id
        LEFT JOIN message_revisions r ON r.id = (
          SELECT r2.id FROM message_revisions r2
          WHERE r2.message_id = m.id AND r2.created_at <= ${source.createdAt}
          ORDER BY r2.revision_no DESC LIMIT 1
        )
        LEFT JOIN senders s ON s.id = r.sender_id
        WHERE m.conversation_id = ${source.conversationId}
          AND m.visible = 1
          AND (im.message_id IS NOT NULL OR m.received_at <= ${source.createdAt})
          AND m.telegram_message_id > COALESCE(
            (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = ${source.conversationId}),
            -1)
          AND (m.telegram_date < ${last.telegram_date} OR
            (m.telegram_date = ${last.telegram_date} AND m.telegram_message_id < ${BigInt(last.message_id)}))
          AND m.id NOT IN (SELECT bm.message_id FROM bucket_messages bm
            JOIN invocation_buckets ib ON ib.bucket_id = bm.bucket_id WHERE ib.invocation_id = ${invocationId})
          AND m.id NOT IN (
            SELECT im.message_id FROM invocation_messages im
            WHERE im.invocation_id = ${invocationId} AND im.section = 'new')
        ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
        LIMIT ${BigInt(config.agent.history_messages)}`,
  );
  return renderHistoryRows(store, rows, source, config.agent.history_messages);
}

export function renderHistoryRows(
  store: BusinessStore,
  rows: readonly HistoryRow[],
  source: SceneSource,
  limit = rows.length,
): { readonly newestFirst: readonly SceneMessage[]; readonly missing: number } {
  const revisionIds = rows.flatMap((row) => (row.revision_id === null ? [] : [row.revision_id]));
  const mediaByRevision = new Map<bigint, HistoryMediaRow[]>();
  if (revisionIds.length > 0) {
    const mediaRows = store.orm
      .select({
        revisionId: media.revisionId,
        id: media.id,
        kind: media.kind,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
      })
      .from(media)
      .where(inArray(media.revisionId, revisionIds))
      .orderBy(media.id)
      .all();
    for (const row of mediaRows) {
      const entry: HistoryMediaRow = {
        revision_id: row.revisionId,
        id: row.id,
        kind: row.kind,
        mime_type: row.mimeType,
        width: row.width,
        height: row.height,
      };
      const list = mediaByRevision.get(row.revisionId);
      if (list === undefined) {
        mediaByRevision.set(row.revisionId, [entry]);
      } else {
        list.push(entry);
      }
    }
  }
  const newestFirst: SceneMessage[] = [];
  let missing = 0;
  for (const row of rows) {
    if (row.snapshot_json !== null) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (
        !storedSnapshotValidator.Check(parsed) ||
        row.frozen_revision_id === null ||
        parsed.message_id !== row.telegram_message_id.toString() ||
        parsed.telegram_date !== row.telegram_date ||
        (parsed.message_thread_id !== undefined && parsed.message_thread_id !== source.threadId.toString())
      ) {
        throw new Error('Scene context: invalid history snapshot');
      }
      const absent = missingMediaIds(
        store,
        parsed.media.map((image) => BigInt(image.id)),
        row.frozen_revision_id,
      );
      newestFirst.push({
        snapshot: {
          ...parsed,
          media: parsed.media.map((image) => ({
            kind: image.kind,
            mime_type: image.mime_type,
            width: image.width,
            height: image.height,
            image_ref: absent.has(BigInt(image.id)) ? MEDIA_MISSING : MEDIA_UNAVAILABLE,
          })),
        },
        mediaIds: parsed.media.map((image) => BigInt(image.id)),
      });
      continue;
    }
    if (row.revision_id === null) {
      missing += 1;
      continue;
    }
    const mediaRows = mediaByRevision.get(row.revision_id) ?? [];
    const replySnapshot = parseStoredJson(row.reply_snapshot_json);
    const body = bodyFromFragment(row.raw_fragment_json, {
      text: row.text,
      caption: row.caption,
      reply_snapshot: replySnapshot,
      mediaCount: mediaRows.length,
    });
    newestFirst.push({
      snapshot: {
        message_id: row.telegram_message_id.toString(),
        message_thread_id: source.threadId.toString(),
        telegram_date: row.telegram_date,
        sent_by_bot: row.sent_by_bot === 1n,
        sender: {
          id: row.sender_telegram_id?.toString() ?? null,
          name: row.sender_display_name,
          username: row.sender_username,
        },
        kind: row.kind ?? 'unknown',
        text: body.text,
        caption: body.caption,
        ...(body.spoilers === undefined ? {} : { spoilers: body.spoilers }),
        ...(body.media_slots === undefined ? {} : { media_slots: body.media_slots }),
        reply_to_message_id: row.reply_to_message_id?.toString() ?? null,
        reply_snapshot: replySnapshot,
        forward_origin: parseStoredJson(row.forward_origin_json),
        media_group_id: row.media_group_id,
        media: mediaRows.map((entry) => ({
          image_ref: MEDIA_UNAVAILABLE,
          kind: entry.kind,
          mime_type: entry.mime_type,
          width: entry.width?.toString() ?? null,
          height: entry.height?.toString() ?? null,
        })),
      },
      mediaIds: mediaRows.map((entry) => entry.id),
    });
  }
  const unique = new Map(newestFirst.map((entry) => [entry.snapshot.message_id, entry]));
  return {
    newestFirst: [...unique.values()].sort((a, b) => compareMessages(b.snapshot, a.snapshot)).slice(0, limit),
    missing,
  };
}

export function compareMessages(
  a: Pick<PreparedSnapshot, 'telegram_date' | 'message_id'>,
  b: Pick<PreparedSnapshot, 'telegram_date' | 'message_id'>,
): number {
  if (a.telegram_date !== b.telegram_date) {
    return a.telegram_date < b.telegram_date ? -1 : 1;
  }
  const left = BigInt(a.message_id);
  const right = BigInt(b.message_id);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function missingMediaIds(store: BusinessStore, ids: readonly bigint[], revisionId: bigint): ReadonlySet<bigint> {
  if (ids.length === 0) {
    return new Set();
  }
  const present = new Set(
    store.orm
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.id, ids), eq(media.revisionId, revisionId)))
      .all()
      .map((row) => row.id),
  );
  return new Set(ids.filter((id) => !present.has(id)));
}

/** Stored JSON that a scene only ever displays: a corrupt copy renders as absent, never crashes. */
function parseStoredJson(json: string | null): unknown {
  if (json === null) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * The runtime block's clock line. `ContextBuilder#renderCurrentTime` is the
 * production twin but stays private; this is the only piece of the injection
 * envelope the scene renders itself.
 */
export function renderCurrentTime(timezone: string, now: Date): string {
  return `${new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
    hourCycle: 'h23',
  }).format(now)} (${timezone})`;
}
