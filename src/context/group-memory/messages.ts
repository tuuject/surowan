import { sql } from 'drizzle-orm';
import type { Orm } from '../../store/store.ts';
import { GROUP_MEMORY_BATCH_MAX_MESSAGES, GROUP_MEMORY_READ_MAX_MESSAGES } from './index.ts';

/**
 * Raw stored Telegram messages for group memory.
 *
 * Both the sleeping worker and `read_group_messages` read the current revision
 * (what the Chat currently shows), never an invocation snapshot: a memory may
 * summarize messages that never triggered an Invocation at all. Rows are
 * selected by message number so a memory's range means the same thing to
 * the model and to a human scrolling the Chat.
 */

export interface GroupMemoryMessageRow {
  readonly messageId: bigint;
  readonly messageNo: bigint;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly sentByBot: boolean;
  readonly threadId: bigint;
  readonly revisionId: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly senderHostId: bigint | null;
  readonly senderName: string | null;
  readonly senderUsername: string | null;
  readonly mediaKinds: readonly string[];
}

interface RawRow {
  readonly message_id: bigint;
  readonly message_no: bigint;
  readonly sent_at: string;
  readonly received_at: string;
  readonly sent_by_bot: boolean;
  readonly message_thread_id: bigint;
  readonly revision_id: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly sender_host_id: bigint | null;
  readonly sender_name: string | null;
  readonly sender_username: string | null;
}

const SELECT_ROWS = sql`
  SELECT m.id AS message_id, m.message_no, m.sent_at, m.received_at, m.sent_by_bot,
         v.message_thread_id,
         r.id AS revision_id, r.kind, r.text, r.caption,
         s.host_sender_id AS sender_host_id, s.display_name AS sender_name, s.username AS sender_username
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
    messageNo: row.message_no,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    sentByBot: row.sent_by_bot,
    threadId: row.message_thread_id,
    revisionId: row.revision_id,
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    senderHostId: row.sender_host_id,
    senderName: row.sender_name,
    senderUsername: row.sender_username,
    mediaKinds: mediaByRevision.get(row.revision_id.toString()) ?? [],
  }));
}

/**
 * A lane's unconsolidated messages: message numbers after `after` and, for a
 * backfill lane, at most `until` (inclusive). `until = null` is open-ended.
 */
export interface PendingRange {
  readonly after: bigint;
  readonly until: bigint | null;
}

function pendingCondition(chatId: bigint, range: PendingRange) {
  return range.until === null
    ? sql`m.chat_id = ${chatId} AND m.visible = 1 AND m.message_no > ${range.after}`
    : sql`m.chat_id = ${chatId} AND m.visible = 1 AND m.message_no > ${range.after}
          AND m.message_no <= ${range.until}`;
}

/** Pending messages of a lane, oldest first, bounded by one batch. */
export function loadPendingMessages(
  orm: Orm,
  chatId: bigint,
  range: PendingRange,
  limit = GROUP_MEMORY_BATCH_MAX_MESSAGES,
): GroupMemoryMessageRow[] {
  const rows = orm.all<RawRow>(
    sql`${SELECT_ROWS}
        WHERE ${pendingCondition(chatId, range)}
        ORDER BY m.message_no
        LIMIT ${BigInt(limit)}`,
  );
  return withMedia(orm, rows);
}

/** The newest pending message of a lane, used for the idle check. */
export function newestPendingMessage(orm: Orm, chatId: bigint, range: PendingRange): GroupMemoryMessageRow | undefined {
  const row = orm
    .all<RawRow>(
      sql`${SELECT_ROWS}
          WHERE ${pendingCondition(chatId, range)}
          ORDER BY m.message_no DESC
          LIMIT 1`,
    )
    .at(0);
  return row === undefined ? undefined : withMedia(orm, [row])[0];
}

/** How many messages a lane still has to consolidate (the panel's backlog). */
export function countPendingMessages(orm: Orm, chatId: bigint, range: PendingRange): number {
  return Number(
    orm
      .all<{ count: bigint }>(sql`SELECT count(*) AS count FROM messages m WHERE ${pendingCondition(chatId, range)}`)
      .at(0)?.count ?? 0n,
  );
}

/** The newest stored message number of a Chat, visible or not; 0 when it has none. */
export function newestMessageId(orm: Orm, chatId: bigint): bigint {
  return (
    orm.all<{ id: bigint | null }>(sql`SELECT max(message_no) AS id FROM messages WHERE chat_id = ${chatId}`).at(0)
      ?.id ?? 0n
  );
}

/** The newest stored message number sent before `before`, or undefined. */
export function lastMessageIdBefore(orm: Orm, chatId: bigint, before: string): bigint | undefined {
  return (
    orm
      .all<{ id: bigint | null }>(
        sql`SELECT max(message_no) AS id FROM messages WHERE chat_id = ${chatId} AND sent_at < ${before}`,
      )
      .at(0)?.id ?? undefined
  );
}

/** When a stored message was sent, for showing a cursor as a date. */
export function messageDate(orm: Orm, chatId: bigint, messageNo: bigint): string | null {
  return (
    orm
      .all<{ sent_at: string }>(
        sql`SELECT sent_at FROM messages WHERE chat_id = ${chatId} AND message_no = ${messageNo}`,
      )
      .at(0)?.sent_at ?? null
  );
}

/** Raw messages whose message numbers fall in the inclusive range. */
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
          AND m.message_no BETWEEN ${firstMessageId} AND ${lastMessageId}
        ORDER BY m.message_no
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
  const header = `[${row.messageNo}${bot}${service}${thread}] ${who}${username}${media}`;
  const content = row.text ?? row.caption;
  if (content === null || content.trim().length === 0) {
    return `${header}\n  [${row.kind}]`;
  }
  return [header, ...content.split('\n').map((line) => `  ${line}`)].join('\n');
}
