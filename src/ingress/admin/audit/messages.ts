import { and, eq, type SQL, sql } from 'drizzle-orm';
import { media, mediaAnalyses, messageRevisions, senders } from '../../../store/schema/index.ts';
import type { Orm } from '../../../store/store.ts';
import {
  AdminQueryError,
  appendCursor,
  bit,
  escapeLike,
  type ListQuery,
  MAX_SEARCH_LENGTH,
  num,
  type Page,
  page,
  parseId,
  parseLimit,
  whereSql,
} from './shared.ts';

interface MessageListRow {
  readonly id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: bigint;
  readonly sent_by_bot: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
  readonly revision_no: bigint | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly media_group_id: string | null;
  readonly sender_display_name: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_telegram_type: string | null;
  readonly sender_username: string | null;
  readonly sender_is_bot: bigint | null;
  readonly revision_count: bigint;
  readonly media_count: bigint;
}

/**
 * The message audit surface reports Telegram chats: it renders Telegram chat
 * ids, message ids and sender ids directly. Virtual rooms have none of those,
 * so those queries state the host they speak instead of reading a Telegram id
 * that a virtual row does not have. Invocations are host-neutral and carry the
 * host in their chat summary instead.
 */
const TELEGRAM_HOST = sql`ch.host_kind = 'telegram'`;

const MESSAGE_SELECT = sql`SELECT m.id, m.telegram_message_id, m.telegram_date, m.received_at, m.visible, m.sent_by_bot,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id,
              r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.media_group_id,
              sd.display_name AS sender_display_name, sd.telegram_id AS sender_telegram_id,
              sd.telegram_type AS sender_telegram_type, sd.username AS sender_username, sd.is_bot AS sender_is_bot,
              (SELECT COUNT(*) FROM message_revisions mr WHERE mr.message_id = m.id) AS revision_count,
              (SELECT COUNT(*) FROM media md WHERE md.revision_id = m.current_revision_id) AS media_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN chats ch ON ch.id = m.chat_id
       LEFT JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders sd ON sd.id = r.sender_id`;

export function listMessages(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [TELEGRAM_HOST];
  appendCursor(conditions, sql`m.id`, query.cursor);
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(sql`ch.telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) {
      throw new AdminQueryError('invalid_search', 'Search text is too long');
    }
    const like = escapeLike(query.search);
    conditions.push(sql`(r.text LIKE ${like} ESCAPE '\\' OR r.caption LIKE ${like} ESCAPE '\\')`);
  }
  const rows = orm.all<MessageListRow>(
    sql`${MESSAGE_SELECT} ${whereSql(conditions)} ORDER BY m.id DESC LIMIT ${BigInt(limit + 1)}`,
  );
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    telegram_message_id: row.telegram_message_id.toString(),
    telegram_date: row.telegram_date,
    received_at: row.received_at,
    visible: bit(row.visible),
    sent_by_bot: bit(row.sent_by_bot),
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: Number(row.message_thread_id),
    },
    revision_no: num(row.revision_no),
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    reply_to_message_id: row.reply_to_message_id === null ? null : row.reply_to_message_id.toString(),
    media_group_id: row.media_group_id,
    sender:
      row.sender_display_name === null
        ? null
        : {
            display_name: row.sender_display_name,
            telegram_id: row.sender_telegram_id?.toString() ?? null,
            telegram_type: row.sender_telegram_type,
            username: row.sender_username,
            is_bot: bit(row.sender_is_bot),
          },
    revision_count: Number(row.revision_count),
    media_count: Number(row.media_count),
  }));
}

export function getMessage(orm: Orm, id: bigint): Record<string, unknown> | null {
  const message = orm
    .all<MessageListRow>(sql`${MESSAGE_SELECT} WHERE m.id = ${id} AND ch.host_kind = 'telegram'`)
    .at(0);
  if (message === undefined) {
    return null;
  }
  const revisionRows = orm
    .select({
      id: messageRevisions.id,
      revisionNo: messageRevisions.revisionNo,
      kind: messageRevisions.kind,
      text: messageRevisions.text,
      caption: messageRevisions.caption,
      replyToMessageId: messageRevisions.replyToMessageId,
      replySnapshotJson: messageRevisions.replySnapshotJson,
      forwardOriginJson: messageRevisions.forwardOriginJson,
      mediaGroupId: messageRevisions.mediaGroupId,
      serviceJson: messageRevisions.serviceJson,
      createdAt: messageRevisions.createdAt,
      senderDisplayName: senders.displayName,
      senderTelegramId: senders.telegramId,
      senderTelegramType: senders.telegramType,
      senderUsername: senders.username,
    })
    .from(messageRevisions)
    .leftJoin(senders, eq(messageRevisions.senderId, senders.id))
    .where(eq(messageRevisions.messageId, id))
    .orderBy(messageRevisions.revisionNo)
    .all();
  const mediaRows = orm
    .select({
      id: media.id,
      revisionId: media.revisionId,
      kind: media.kind,
      fileUniqueId: media.fileUniqueId,
      mimeType: media.mimeType,
      fileSize: media.fileSize,
      width: media.width,
      height: media.height,
      analysisState: mediaAnalyses.state,
      analysisDescription: mediaAnalyses.description,
    })
    .from(media)
    .innerJoin(messageRevisions, eq(media.revisionId, messageRevisions.id))
    .leftJoin(
      mediaAnalyses,
      and(eq(mediaAnalyses.fileUniqueId, media.fileUniqueId), eq(mediaAnalyses.state, 'success')),
    )
    .where(eq(messageRevisions.messageId, id))
    .orderBy(media.id)
    .all();
  return {
    id: message.id.toString(),
    telegram_message_id: message.telegram_message_id.toString(),
    telegram_date: message.telegram_date,
    received_at: message.received_at,
    visible: bit(message.visible),
    sent_by_bot: bit(message.sent_by_bot),
    chat: {
      telegram_chat_id: message.telegram_chat_id.toString(),
      type: message.chat_type,
      title: message.chat_title,
      message_thread_id: Number(message.message_thread_id),
    },
    revisions: revisionRows.map((row) => ({
      id: row.id.toString(),
      revision_no: Number(row.revisionNo),
      kind: row.kind,
      text: row.text,
      caption: row.caption,
      reply_to_message_id: row.replyToMessageId === null ? null : row.replyToMessageId.toString(),
      reply_snapshot_json: row.replySnapshotJson,
      forward_origin_json: row.forwardOriginJson,
      media_group_id: row.mediaGroupId,
      service_json: row.serviceJson,
      created_at: row.createdAt,
      sender:
        row.senderDisplayName === null
          ? null
          : {
              display_name: row.senderDisplayName,
              telegram_id: row.senderTelegramId?.toString() ?? null,
              telegram_type: row.senderTelegramType,
              username: row.senderUsername,
            },
    })),
    media: mediaRows.map((row) => ({
      id: row.id.toString(),
      revision_id: row.revisionId.toString(),
      kind: row.kind,
      file_unique_id: row.fileUniqueId,
      mime_type: row.mimeType,
      file_size: num(row.fileSize),
      width: num(row.width),
      height: num(row.height),
      analysis_state: row.analysisState,
      analysis_description: row.analysisDescription,
    })),
  };
}
