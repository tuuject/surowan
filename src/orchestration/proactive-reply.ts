import { eq, sql } from 'drizzle-orm';
import type { Message } from 'grammy/types';
import type { FileChat } from '../platform/config/index.ts';
import { matchTriggerKind, type TriggerKind } from '../platform/participation.ts';
import { proactiveReplyFingerprint, resolveProactiveReply, sampleProactiveReply } from '../platform/proactive-reply.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { proactiveReplyState } from '../store/schema/index.ts';
import type { Orm } from '../store/store.ts';

export interface ProactiveReplyGateOptions {
  readonly bot: { readonly id: bigint; readonly username: string | null };
  /** Test seam; production uses `Math.random`. */
  readonly random?: () => number;
}

export interface ProactiveReplyDecision {
  readonly allowed: boolean;
  /** `disabled` and `direct` never touch the pity counter. */
  readonly reason: 'disabled' | 'direct' | 'hit' | 'miss';
  readonly triggerKind: TriggerKind | null;
}

/**
 * One sampling decision per aggregated Bucket, made immediately before its
 * Invocation is created or attached. Group chats only: private messages are
 * always directed at the bot. The counter is keyed by Chat, so Forum Topics
 * share one proactive budget, and it is updated in the same synchronous
 * transaction as the bucket transition.
 */
export class ProactiveReplyGate {
  readonly #orm: Orm;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #bot: ProactiveReplyGateOptions['bot'];
  readonly #random: () => number;

  constructor(orm: Orm, configStore: RuntimeConfigurationStore, options: ProactiveReplyGateOptions) {
    this.#orm = orm;
    this.#configStore = configStore;
    this.#bot = options.bot;
    this.#random = options.random ?? Math.random;
  }

  decide(options: {
    readonly bucketId: bigint;
    /** Internal `chats.id`, the counter key. */
    readonly chatId: bigint;
    readonly telegramChatId: bigint;
    readonly chatType: string;
    readonly conversationId: bigint;
    readonly chat: Pick<FileChat, 'proactive_reply'>;
    readonly keywords: readonly string[];
    readonly now: Date;
  }): ProactiveReplyDecision {
    if (options.chatType === 'private') {
      return { allowed: true, reason: 'disabled', triggerKind: null };
    }
    const settings = resolveProactiveReply(this.#configStore.current().config, options.chat);
    if (!settings.enabled) {
      return { allowed: true, reason: 'disabled', triggerKind: null };
    }
    const triggerKind = this.#directTriggerKind(options.bucketId, options.keywords);
    if (triggerKind !== null) {
      this.#log({
        event: 'agent_proactive_reply_bypassed',
        chat_id: options.telegramChatId.toString(),
        conversation_id: options.conversationId.toString(),
        bucket_id: options.bucketId.toString(),
        trigger_kind: triggerKind,
        at: options.now.toISOString(),
      });
      return { allowed: true, reason: 'direct', triggerKind };
    }
    const fingerprint = proactiveReplyFingerprint(settings);
    const state = this.#orm
      .select({
        misses: proactiveReplyState.consecutiveMisses,
        fingerprint: proactiveReplyState.settingsFingerprint,
      })
      .from(proactiveReplyState)
      .where(eq(proactiveReplyState.chatId, options.chatId))
      .get();
    const stateReset = state !== undefined && state.fingerprint !== fingerprint;
    const missesBefore = stateReset ? 0 : Number(state?.misses ?? 0n);
    const sample = sampleProactiveReply(missesBefore, settings, this.#random);
    const missesAfter = sample.hit ? 0 : missesBefore + 1;
    const timestamp = options.now.toISOString();
    this.#orm
      .insert(proactiveReplyState)
      .values({
        chatId: options.chatId,
        consecutiveMisses: BigInt(missesAfter),
        settingsFingerprint: fingerprint,
        lastSampledAt: timestamp,
      })
      .onConflictDoUpdate({
        target: proactiveReplyState.chatId,
        set: {
          consecutiveMisses: BigInt(missesAfter),
          settingsFingerprint: fingerprint,
          lastSampledAt: timestamp,
        },
      })
      .run();
    this.#log({
      event: 'agent_proactive_reply_sampled',
      chat_id: options.telegramChatId.toString(),
      conversation_id: options.conversationId.toString(),
      bucket_id: options.bucketId.toString(),
      attempt: sample.attempt,
      probability: sample.probability,
      consecutive_misses_before: missesBefore,
      consecutive_misses_after: missesAfter,
      hit: sample.hit,
      hard_pity: sample.pity,
      state_reset: stateReset,
      at: timestamp,
    });
    return { allowed: sample.hit, reason: sample.hit ? 'hit' : 'miss', triggerKind: null };
  }

  /**
   * A direct cue anywhere in the frozen batch makes the whole batch direct:
   * one attempt is one aggregated batch, not one message.
   */
  #directTriggerKind(bucketId: bigint, keywords: readonly string[]): TriggerKind | null {
    const stickerTrigger = this.#configStore.current().config.telegram.sticker_trigger_enabled === true ? 1 : 0;
    const rows = this.#orm.all<{ raw_fragment_json: string | null }>(
      // Messages from bots and the bot's own sends are filtered exactly like
      // ingestion filters them: they may join a batch, but they cannot call the
      // bot. A sticker-only message likewise only counts when stickers are
      // allowed to trigger.
      sqlDirectMessages(bucketId, stickerTrigger),
    );
    for (const row of rows) {
      if (row.raw_fragment_json === null) {
        continue;
      }
      let message: Message;
      try {
        message = JSON.parse(row.raw_fragment_json) as Message;
      } catch {
        continue;
      }
      const kind = matchTriggerKind(message, this.#bot, keywords);
      if (kind !== null) {
        return kind;
      }
    }
    return null;
  }

  #log(fields: Readonly<Record<string, string | number | boolean | null>>): void {
    console.log(JSON.stringify(fields));
  }
}

// Keeps the SQL template next to the only query that uses it.
function sqlDirectMessages(bucketId: bigint, stickerTrigger: number) {
  return sql`SELECT r.raw_fragment_json
    FROM bucket_messages bm
    JOIN messages m ON m.id = bm.message_id
    JOIN message_revisions r ON r.id = m.current_revision_id
    LEFT JOIN senders s ON s.id = r.sender_id
    WHERE bm.bucket_id = ${bucketId}
      AND m.visible = 1
      AND m.sent_by_bot = 0
      AND r.kind <> 'service'
      AND COALESCE(s.is_bot, 0) = 0
      AND (r.text IS NOT NULL OR r.caption IS NOT NULL OR r.reply_to_message_id IS NOT NULL)
      AND (
        r.kind <> 'sticker'
        OR r.text IS NOT NULL
        OR r.caption IS NOT NULL
        OR EXISTS (SELECT 1 FROM media md WHERE md.revision_id = r.id AND md.kind <> 'sticker')
        OR ${stickerTrigger} = 1
      )
    ORDER BY bm.sequence_no`;
}
