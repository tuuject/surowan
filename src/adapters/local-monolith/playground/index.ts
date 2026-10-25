/**
 * The virtual host of a Bot Playground room.
 *
 * A room has no wire, so this host has nothing to translate and nothing to
 * send. What it does own is the other half of a delivery: publishing the
 * message the bot produced - the message row, its first revision, any local
 * pictures it carried and the local arrival order - and recording the send
 * that produced it, in one transaction keyed by the send ledger row.
 *
 * Everything a Telegram host reports from the wire (`sentAtSeconds`, a host
 * message id) is therefore decided here instead, which is why the caller does
 * not mirror or finalize anything this host accepted. A room's host message id
 * is its sequence number, in both directions: a reply names the sequence the
 * model was shown, and a delivery reports the sequence it took. Row ids stay
 * inside this file.
 */
import type { LocalAsset, LocalAssetInput } from '../../../capabilities/media/local-assets.ts';
import {
  conversationKey,
  type ImActivity,
  type ImConversationPolicy,
  type ImConversationRef,
  type ImDeliveryTarget,
  type ImHost,
  type ImSendRatePolicy,
  resolveConversationPolicy,
} from '../../../platform/im-host.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { createPlaygroundDelivery } from './delivery.ts';
import { createRoomReaders } from './room.ts';

/** Who a room shows as the author of the messages the bot publishes. */
export interface PlaygroundSelfIdentity {
  readonly displayName: string;
  readonly username?: string | null;
}

/** The room's local picture store, as a delivery uses it. */
export interface PlaygroundPictures {
  /** Refuses a picture `ingest` would refuse, without writing anything. */
  validate(input: LocalAssetInput): Promise<void>;
  /**
   * Validates and stores one picture; content-addressed per room. `created`
   * is false when the room already held the same bytes.
   */
  ingest(chatId: bigint, input: LocalAssetInput): Promise<LocalAsset & { readonly created: boolean }>;
  /** Removes an asset this host created, unless a message references it. */
  discard(assetId: string): Promise<void>;
  /** Points an asset at the message media row that now owns it. */
  markAttached(assetId: string, mediaId: bigint): void;
}

export interface PlaygroundHostOptions {
  /** The store a delivery writes through. Also supplies the transaction. */
  readonly store: BusinessStore;
  readonly self: PlaygroundSelfIdentity;
  /** Local pictures; without it a room cannot publish an image message. */
  readonly pictures?: PlaygroundPictures;
  /** Resolved per call: it is pure, and the configured rate can change. */
  readonly sendRate: () => ImSendRatePolicy;
  readonly now?: () => Date;
}

export function createPlaygroundHost(options: PlaygroundHostOptions): ImHost {
  const { store, self } = options;
  const now = options.now ?? ((): Date => new Date());

  const room = createRoomReaders({ store, self, pictures: options.pictures });
  const delivery = createPlaygroundDelivery({ store, pictures: options.pictures, now, room });

  const policy = (conversation: ImConversationRef): ImConversationPolicy =>
    resolveConversationPolicy({
      host: 'playground',
      scope: conversation.scope,
      sendRate: options.sendRate(),
    });

  /**
   * A room has no chat action to show. The UI reads the working state off the
   * invocation, so an entry here only exists to stop by itself if a run never
   * does; nothing polls it.
   */
  const activeUntil = new Map<string, number>();

  const prune = (at: number): void => {
    for (const [key, expiry] of activeUntil) {
      if (expiry <= at) {
        activeUntil.delete(key);
      }
    }
  };

  const activity: ImActivity = {
    start: (target: ImDeliveryTarget): void => {
      const at = now().getTime();
      prune(at);
      activeUntil.set(conversationKey(target.conversation), at + (target.policy.activity.capMs ?? 0));
    },
    stop: (conversation: ImConversationRef): void => {
      prune(now().getTime());
      activeUntil.delete(conversationKey(conversation));
    },
    stopAll: (): void => {
      activeUntil.clear();
    },
  };

  return { host: 'playground', policy, delivery, activity };
}
