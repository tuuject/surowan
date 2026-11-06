import { sql } from 'drizzle-orm';
import type { Orm } from '../../store/store.ts';
import { GROUP_MEMORY_BATCH_MAX_MESSAGES, GROUP_MEMORY_READ_MAX_MESSAGES } from './index.ts';

/**
 * Raw stored Telegram messages for group memory.
 *
 * Both the sleeping worker and `read_group_messages` read the current revision
 * (what the Chat currently shows), never an invocation snapshot: a memory may
 * summarize messages that never triggered an Invocation at all. Rows are
 * selected by Telegram message id so a memory's range means the same thing to
 * the model and to a human scrolling the Chat.
 */

export interface GroupMemoryMessageRow {
  readonly messageId: bigint;
  readonly telegramMessageId: bigint;
  readonly telegramDate: string;
  readonly receivedAt: string;
  readonly sentByBot: boolean;
  readonly threadId: bigint;
  readonly revisionId: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly senderTelegramId: bigint | null;
  readonly senderName: string | null;
  readonly senderUsername: string | null;
  readonly mediaKinds: readonly string[];
}

interface RawRow {
  readonly message_id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly sent_by_bot: boolean;
  readonly message_thread_id: bigint;
  readonly revision_id: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_name: string | null;
  readonly sender_username: string | null;
}

const SELECT_ROWS = sql`
  SELECT m.id AS message_id, m.telegram_message_id, m.telegram_date, m.received_at, m.sent_by_bot,
         v.message_thread_id,
         r.id AS revision_id, r.kind, r.text, r.caption,
         s.telegram_id AS sender_telegram_id, s.display_name AS sender_name, s.username AS sender_username
  FROM messages m
  JOIN conversations v ON v.id = m.conversation_id
  JOIN message_revisions r ON r.id = m.current_revision_id
  LEFT JOIN senders s ON s.id = r.sender_id
`;

function withMedia(orm: Orm, rows: readonly RawRow[]): GroupMemoryMessageRow[] {
  const revisionIds = rows.map((row) => row.revision_id);
  const mediaByRevision = new Map<string, string[]>();
  if (revisionIds.length > 0) {
    const mediaRows = orm.all<{ revision_id: bigint; kind: string }>(
      sql`SELECT revision_id, kind FROM media WHERE revision_id IN (${sql.join(
        revisionIds.map((id) => sql`${id}`),
        sql`, `,
      )}) ORDER BY id`,
    );
    for (const media of mediaRows) {
      const key = media.revision_id.toString();
      const list = mediaByRevision.get(key);
      if (list === undefined) {
        mediaByRevision.set(key, [media.kind]);
      } else {
        list.push(media.kind);
      }
    }
  }
  return rows.map((row) => ({
    messageId: row.message_id,
    telegramMessageId: row.telegram_message_id,
    telegramDate: row.telegram_date,
    receivedAt: row.received_at,
    sentByBot: row.sent_by_bot,
    threadId: row.message_thread_id,
    revisionId: row.revision_id,
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    senderTelegramId: row.sender_telegram_id,
    senderName: row.sender_name,
    senderUsername: row.sender_username,
    mediaKinds: mediaByRevision.get(row.revision_id.toString()) ?? [],
  }));
}

/** Messages newer than the watermark, oldest first, bounded by one batch. */
export function loadPendingMessages(
  orm: Orm,
  chatId: bigint,
  watermark: bigint,
  limit = GROUP_MEMORY_BATCH_MAX_MESSAGES,
): GroupMemoryMessageRow[] {
  const rows = orm.all<RawRow>(
    sql`${SELECT_ROWS}
        WHERE m.chat_id = ${chatId} AND m.visible = 1 AND m.telegram_message_id > ${watermark}
        ORDER BY m.telegram_message_id
        LIMIT ${BigInt(limit)}`,
  );
  return withMedia(orm, rows);
}

/** The newest pending message, used for the idle check. */
export function newestPendingMessage(orm: Orm, chatId: bigint, watermark: bigint): GroupMemoryMessageRow | undefined {
  const row = orm
    .all<RawRow>(
      sql`${SELECT_ROWS}
          WHERE m.chat_id = ${chatId} AND m.visible = 1 AND m.telegram_message_id > ${watermark}
          ORDER BY m.telegram_message_id DESC
          LIMIT 1`,
    )
    .at(0);
  return row === undefined ? undefined : withMedia(orm, [row])[0];
}

/** Raw messages whose Telegram ids fall in the inclusive range. */
export function loadMessagesInRange(
  orm: Orm,
  chatId: bigint,
  firstMessageId: bigint,
  lastMessageId: bigint,
  limit = GROUP_MEMORY_READ_MAX_MESSAGES,
): GroupMemoryMessageRow[] {
  const rows = orm.all<RawRow>(
    sql`${SELECT_ROWS}
        WHERE m.chat_id = ${chatId} AND m.visible = 1
          AND m.telegram_message_id BETWEEN ${firstMessageId} AND ${lastMessageId}
        ORDER BY m.telegram_message_id
        LIMIT ${BigInt(limit)}`,
  );
  return withMedia(orm, rows);
}

/** One line per message, with the body indented so chat text cannot forge a header. */
export function renderGroupTranscript(rows: readonly GroupMemoryMessageRow[]): string {
  if (rows.length === 0) {
    return 'No messages in this range.';
  }
  return rows.map(renderMessage).join('\n');
}

function renderMessage(row: GroupMemoryMessageRow): string {
  // Display names are Telegram-controlled: flatten them so no newline can start
  // a line outside the indented body and forge the surrounding envelope.
  const who = (row.senderName ?? 'unknown').replace(/\s+/g, ' ').trim() || 'unknown';
  const username = row.senderUsername === null ? '' : ` @${row.senderUsername.replace(/\s+/g, '')}`;
  const bot = row.sentByBot ? ' you' : '';
  // A runtime-written service body (`joined the group`) reads like chat text,
  // so the header marks it where no member can type.
  const service = row.kind === 'service' ? ' service' : '';
  const thread = row.threadId === 0n ? '' : ` topic:${row.threadId}`;
  const media = row.mediaKinds.length === 0 ? '' : ` [${row.mediaKinds.join(' ')}]`;
  const header = `[${row.telegramMessageId}${bot}${service}${thread}] ${who}${username}${media}`;
  const content = row.text ?? row.caption;
  if (content === null || content.trim().length === 0) {
    return `${header}\n  [${row.kind}]`;
  }
  return [header, ...content.split('\n').map((line) => `  ${line}`)].join('\n');
}
