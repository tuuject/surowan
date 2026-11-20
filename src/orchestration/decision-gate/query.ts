import { sql } from 'drizzle-orm';
import type { Orm } from '../../store/store.ts';

/** One message the decision request renders; the current revision supplies the body. */
export interface DecisionMessageRow {
  readonly sent_at: string;
  readonly message_no: bigint;
  readonly sent_by_bot: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_snapshot_json: string | null;
  /** Whether the message the reply snapshot quotes was sent by the bot. */
  readonly reply_from_bot: bigint | null;
  readonly sender_display_name: string | null;
}

export interface DecisionMessages {
  readonly history: readonly DecisionMessageRow[];
  readonly pending: readonly DecisionMessageRow[];
}

/**
 * The batch's fingerprint: its newest `sequence_no` and its newest current
 * revision. An edit adds a revision without touching `bucket_messages`, and
 * revision ids only grow, so a verdict reached for the old text is recognised
 * as describing a batch that no longer exists.
 */
export function bucketFingerprint(orm: Orm, bucketId: bigint): string {
  const row = orm
    .all<{ sequence: bigint | null; revision: bigint | null }>(
      sql`SELECT MAX(bm.sequence_no) AS sequence, MAX(m.current_revision_id) AS revision
          FROM bucket_messages bm JOIN messages m ON m.id = bm.message_id
          WHERE bm.bucket_id = ${bucketId}`,
    )
    .at(0);
  return `${row?.sequence ?? 0n}:${row?.revision ?? 0n}`;
}

export function readBucketState(orm: Orm, bucketId: bigint): { state: string } | undefined {
  return orm.all<{ state: string }>(sql`SELECT state FROM buckets WHERE id = ${bucketId}`).at(0);
}

/**
 * The messages of one request, read inside the due transaction so the decision
 * describes the batch as it was frozen:
 *
 * - `history`: the newest `historyMessages` visible messages of the Conversation
 *   before the batch's first message, in time order.
 * - `pending`: the batch's newest `pendingMessages` visible messages by
 *   `sequence_no`, in `sequence_no` order.
 *
 * Both use the current revision, the same row every other reader of "what the
 * model sees" uses; the context cutoff of `/cut_topic` applies to history, as it
 * does for `snapshotInvocation`.
 */
export function readDecisionMessages(input: {
  readonly orm: Orm;
  readonly bucketId: bigint;
  readonly conversationId: bigint;
  readonly historyMessages: number;
  readonly pendingMessages: number;
}): DecisionMessages {
  const history: DecisionMessageRow[] = [];
  if (input.historyMessages > 0) {
    const first = input.orm
      .all<{ sent_at: string; message_no: bigint }>(
        sql`SELECT m.sent_at, m.message_no FROM bucket_messages bm JOIN messages m ON m.id = bm.message_id
            WHERE bm.bucket_id = ${input.bucketId} ORDER BY bm.sequence_no LIMIT 1`,
      )
      .at(0);
    if (first !== undefined) {
      history.push(
        ...input.orm.all<DecisionMessageRow>(
          sql`${MESSAGE_COLUMNS}
              FROM messages m
              JOIN message_revisions r ON r.id = m.current_revision_id
              LEFT JOIN senders s ON s.id = r.sender_id
              ${REPLY_JOIN}
              WHERE m.conversation_id = ${input.conversationId}
                AND m.visible = 1
                AND NOT EXISTS (SELECT 1 FROM bucket_messages own WHERE own.bucket_id = ${input.bucketId} AND own.message_id = m.id)
                AND m.message_no > COALESCE(
                  (SELECT message_no FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
                AND (m.sent_at < ${first.sent_at} OR (m.sent_at = ${first.sent_at} AND m.message_no < ${first.message_no}))
              ORDER BY m.sent_at DESC, m.message_no DESC
              LIMIT ${BigInt(input.historyMessages)}`,
        ),
      );
      history.reverse();
    }
  }
  const pending = input.orm
    .all<DecisionMessageRow>(
      sql`${MESSAGE_COLUMNS}
          FROM bucket_messages bm
          JOIN messages m ON m.id = bm.message_id
          JOIN message_revisions r ON r.id = m.current_revision_id
          LEFT JOIN senders s ON s.id = r.sender_id
          ${REPLY_JOIN}
          WHERE bm.bucket_id = ${input.bucketId} AND m.visible = 1
          ORDER BY bm.sequence_no DESC
          LIMIT ${BigInt(input.pendingMessages)}`,
    )
    .reverse();
  return { history, pending };
}

const MESSAGE_COLUMNS = sql`SELECT m.sent_at, m.message_no, m.sent_by_bot, r.kind, r.text, r.caption,
       r.reply_snapshot_json, quoted.sent_by_bot AS reply_from_bot, s.display_name AS sender_display_name`;

// A reply quotes the wire message ID; `messages.message_no` is that same ID
// inside the Chat, so the bot's own message is one join away without parsing a
// host fragment. The join carries `chat_id` on purpose: `message_no` is unique
// per Chat (`messages_chat_message_no_key`), and a lookup by it must name the
// internal Chat id instead of scanning a whole Conversation.
const REPLY_JOIN = sql`LEFT JOIN messages quoted
  ON quoted.chat_id = m.chat_id AND quoted.message_no = r.reply_to_message_id`;
