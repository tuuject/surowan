import { eq } from 'drizzle-orm';
import { hostIntakeSettings } from '../platform/config/index.ts';
import type { FileChat } from '../platform/config/index.ts';
import type { BotIdentity } from '../platform/im-host/cues.ts';
import type { HostKind } from '../platform/im-host/identity.ts';
import type { TriggerKind } from '../platform/participation.ts';
import { proactiveReplyFingerprint, resolveProactiveReply, sampleProactiveReply } from '../platform/proactive-reply.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { proactiveReplyState } from '../store/schema/index.ts';
import type { Orm } from '../store/store.ts';
import { bucketDirectTriggerKind } from './direct-trigger.ts';

export interface ProactiveReplyGateOptions {
  readonly bot: BotIdentity;
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
    /** Which IM host the Chat belongs to; the intake flags read under it. */
    readonly hostKind: HostKind;
    /** Host-native Chat id, logged as the wire identity. */
    readonly hostChatId: bigint;
    readonly chatType: string;
    readonly conversationId: bigint;
    readonly chat: Pick<FileChat, 'proactive_reply'>;
    readonly keywords: readonly string[];
    readonly now: Date;
  }): ProactiveReplyDecision {
    if (options.chatType === 'private') {
      return { allowed: true, reason: 'disabled', triggerKind: null };
    }
    const settings = resolveProactiveReply(
      hostIntakeSettings(this.#configStore.current().config, options.hostKind),
      options.chat,
    );
    if (!settings.enabled) {
      return { allowed: true, reason: 'disabled', triggerKind: null };
    }
    const triggerKind = this.#directTriggerKind(options.bucketId, options.keywords, options.hostKind);
    if (triggerKind !== null) {
      this.#log({
        event: 'agent_proactive_reply_bypassed',
        chat_id: options.hostChatId.toString(),
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
      chat_id: options.hostChatId.toString(),
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

  #directTriggerKind(bucketId: bigint, keywords: readonly string[], hostKind: HostKind): TriggerKind | null {
    return bucketDirectTriggerKind({
      orm: this.#orm,
      config: this.#configStore.current().config,
      hostKind,
      bucketId,
      bot: this.#bot,
      keywords,
    });
  }

  #log(fields: Readonly<Record<string, string | number | boolean | null>>): void {
    console.log(JSON.stringify(fields));
  }
}
