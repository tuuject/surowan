import { sql } from 'drizzle-orm';
import { hostIntakeSettings, type RawConfig } from '../platform/config/index.ts';
import type { BotIdentity } from '../platform/im-host/cues.ts';
import type { HostKind } from '../platform/im-host/identity.ts';
import { matchTriggerKind, type TriggerKind } from '../platform/participation.ts';
import { rawFragmentReader } from '../platform/raw-fragments.ts';
import type { Orm } from '../store/store.ts';

/**
 * Whether a frozen batch carries a direct cue anywhere, and which one.
 *
 * One attempt is one aggregated batch, not one message: an `/ask`, an
 * @-mention, a reply to the bot or a configured keyword in any message makes
 * the whole batch direct. Two gates ask this question — the proactive reply
 * sampler and the Decisions entry gate — so it lives here instead of in
 * either of them.
 *
 * Messages from bots and the bot's own sends are filtered exactly like
 * ingestion filters them: they may join a batch, but they cannot call the
 * bot. A sticker-only message likewise only counts when stickers are allowed
 * to trigger.
 */
export function bucketDirectTriggerKind(input: {
  readonly orm: Orm;
  readonly config: RawConfig;
  readonly hostKind: HostKind;
  readonly bucketId: bigint;
  /** The bot the cues are matched against; its `id` and `username` are what the reader reads. */
  readonly bot: BotIdentity;
  readonly keywords: readonly string[];
}): TriggerKind | null {
  const stickerTrigger = hostIntakeSettings(input.config, input.hostKind).sticker_trigger_enabled ? 1 : 0;
  const rows = input.orm.all<{
    raw_fragment_json: string | null;
    original_fragment_json: string;
    current_eligible: bigint;
  }>(
    // Messages from bots and the bot's own sends are filtered exactly like
    // ingestion filters them: they may join a batch, but they cannot call the
    // bot.
    sql`SELECT r.raw_fragment_json,
      (SELECT original.raw_fragment_json FROM message_revisions original
       WHERE original.message_id = m.id AND original.revision_no = 1) AS original_fragment_json,
      CASE WHEN r.kind <> 'service'
        AND (r.text IS NOT NULL OR r.caption IS NOT NULL OR r.reply_to_message_id IS NOT NULL)
        AND (r.kind <> 'sticker' OR r.text IS NOT NULL OR r.caption IS NOT NULL
          OR EXISTS (SELECT 1 FROM media md WHERE md.revision_id = r.id AND md.kind <> 'sticker')
          OR ${stickerTrigger} = 1)
        THEN 1 ELSE 0 END AS current_eligible
    FROM bucket_messages bm
    JOIN messages m ON m.id = bm.message_id
    JOIN message_revisions r ON r.id = m.current_revision_id
    LEFT JOIN senders s ON s.id = r.sender_id
    WHERE bm.bucket_id = ${input.bucketId}
      AND m.visible = 1
      AND m.sent_by_bot = 0
      AND COALESCE(s.is_bot, 0) = 0
    ORDER BY bm.sequence_no`,
  );
  const reader = rawFragmentReader(input.hostKind);
  for (const row of rows) {
    // An original-revision ask stays a direct cue even after the message was
    // edited; a malformed fragment simply carries no cue. The ask-only read
    // never walks mention entities or rich text.
    if (reader.asks(row.original_fragment_json, input.bot)) {
      return 'ask';
    }
    if (row.current_eligible !== 1n) {
      continue;
    }
    const kind = matchTriggerKind(reader.cues(row.raw_fragment_json, input.bot), input.keywords, false);
    if (kind !== null) {
      return kind;
    }
  }
  return null;
}
