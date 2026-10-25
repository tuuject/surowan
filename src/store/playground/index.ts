/**
 * Room ingestion: admit inputs, hold them, release them into one invocation.
 *
 * Two invariants drive this module:
 *
 * - A held input is invisible. It is canonical (messages/message_revisions) so
 *   its ordering and content are fixed, but only a release turns held inputs
 *   into a bucket and an invocation. Nothing can run a held message.
 * - A release is at most once per room revision. The revision is bumped by
 *   every admitted input, so two releases that raced on the same revision
 *   cannot both seal the same batch.
 *
 * The bodies live in ./playground/: this class is the public surface, and each
 * method delegates to the module that owns its operation.
 */
import { replaySubmission, submit } from './admission.ts';
import { releaseDetail, roomInvocation, roomInvocations, timeline } from './queries.ts';
import { release } from './release.ts';
import { retry } from './retry.ts';
import { addParticipantWithKey, createRoom, createRoomWithKey, members } from './rooms.ts';
import { type PlaygroundDeps, roomOf, roomSummaryOf } from './shared.ts';
import { expireQueued, hold, listRooms, nextQueuedExpiry, setImageEnabled, stagedAssets, status } from './status.ts';
import type { Orm } from '../store.ts';

export interface RoomState {
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly title: string;
  readonly revision: bigint;
  readonly hold: boolean;
  readonly nextSeq: bigint;
  /**
   * Seq of the latest admitted input, 0 before the first one. Bot output takes
   * room sequence numbers too, so a Release names its boundary with this, not
   * with `nextSeq - 1`.
   */
  readonly latestInputSeq: bigint;
  /** Whether this room may spend real money on image generation. Default off. */
  readonly imageEnabled: boolean;
  /** Operator who last flipped the switch; null while nobody has. */
  readonly imageEnabledBy: string | null;
  readonly imageEnabledAt: string | null;
}

export interface RoomMember {
  readonly senderId: bigint;
  readonly name: string;
  readonly role: 'member' | 'admin';
}

export interface SubmitMedia {
  /** Local asset id allocated by the asset store. */
  readonly assetId: string;
  readonly sha256: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface SubmitInput {
  readonly requestKey: string;
  readonly senderId: bigint;
  readonly text: string;
  readonly replyToSeq?: bigint | null;
  readonly media?: readonly SubmitMedia[];
}

export interface SubmitResult {
  readonly inputId: bigint;
  readonly seq: bigint;
  readonly revision: bigint;
  readonly admitted: boolean;
}

export interface ReleaseInput {
  readonly releaseKey: string;
  readonly revision: bigint;
  /**
   * The highest input sequence the caller believes it is releasing. P0 seals
   * the whole hold, so a mismatch is a stale client (another input landed) and
   * must be refused instead of silently releasing more than was intended.
   */
  readonly throughSeq?: bigint;
}

export interface ReleaseResult {
  readonly releaseId: bigint;
  readonly throughSeq: bigint;
  readonly bucketId: bigint | null;
  readonly invocationId: bigint | null;
  readonly replayed: boolean;
}

export interface RetryInput {
  readonly releaseId: bigint;
  readonly attemptKey: string;
}

export interface RetryResult {
  readonly retryId: bigint;
  readonly invocationId: bigint;
  readonly bucketId: bigint;
  readonly replayed: boolean;
}

export interface HeldInput {
  readonly inputId: bigint;
  readonly seq: bigint;
  readonly messageId: bigint;
  readonly senderId: bigint;
  readonly text: string;
  readonly createdAt: string;
}

export interface ReleaseStatus {
  readonly id: bigint;
  readonly revision: bigint;
  readonly throughSeq: bigint;
  readonly invocationId: bigint | null;
  readonly invocationState: string | null;
  readonly invocationErrorCode: string | null;
  readonly createdAt: string;
}

export interface RoomStatus extends RoomState {
  readonly held: readonly HeldInput[];
  /** Held inputs that retention expired before any release sealed them. */
  readonly expiredInputs: number;
  readonly releases: readonly ReleaseStatus[];
}

/** One room as the admin panel lists it: state plus the counters it shows. */
export interface RoomSummary extends RoomState {
  readonly memberCount: number;
  readonly heldCount: number;
  readonly queuedInvocations: number;
  readonly runningInvocations: number;
  readonly createdAt: string;
}

export interface TimelineMedia {
  readonly messageId: bigint;
  readonly id: bigint;
  readonly kind: string;
  readonly mimeType: string | null;
  readonly fileUniqueId: string;
  readonly width: bigint | null;
  readonly height: bigint | null;
  /** Local asset id when the bytes live in the room store. */
  readonly assetId: string | null;
}

export interface TimelineEntry {
  readonly messageId: bigint;
  readonly seq: bigint;
  readonly sentByBot: boolean;
  readonly createdAt: string;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly senderId: bigint | null;
  readonly senderName: string | null;
  readonly senderIsBot: boolean;
  readonly replyToMessageId: bigint | null;
  readonly replyToSeq: bigint | null;
  /** `held` / `released` / `expired` for an admitted input; null for output. */
  readonly inputState: string | null;
  /** `pending` / `success` / `error` / `outcome_unknown` for bot output. */
  readonly sendState: string | null;
  readonly media: readonly TimelineMedia[];
}

export interface RoomInvocationSummary {
  readonly id: bigint;
  readonly state: string;
  readonly errorCode: string | null;
  readonly completionReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly sendsUsed: number;
  readonly toolCallsUsed: number;
  readonly sideEffectStarted: boolean;
  readonly totalTokens: number;
  readonly totalCost: number | null;
  readonly receiptState: string | null;
  readonly receiptStatus: string | null;
  /** Set when this invocation is a retry of another attempt. */
  readonly retryOfInvocationId: bigint | null;
  /**
   * The Release this attempt belongs to, first run or retry alike: a retry is
   * addressed by release, never by invocation id. Null for a run no Release
   * opened (a receipt delivery).
   */
  readonly releaseId: bigint | null;
}

export interface ReleaseSend {
  readonly id: bigint;
  readonly invocationId: bigint;
  readonly kind: string;
  readonly state: string;
  readonly messageId: bigint | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface ReleaseDetail {
  readonly release: {
    readonly id: bigint;
    readonly revision: bigint;
    readonly throughSeq: bigint;
    readonly bucketId: bigint | null;
    readonly invocationId: bigint | null;
    readonly createdAt: string;
  };
  readonly attempts: readonly RoomInvocationSummary[];
  readonly sends: readonly ReleaseSend[];
}

export interface StagedAsset {
  readonly assetId: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
}

/** How long a released batch may wait for its run before it fails as `queued_expired`. */
export const PLAYGROUND_QUEUE_TTL_MS = 5 * 60_000;

/**
 * Room-local ingestion.
 *
 * All validation and writes happen inside one transaction per operation, so a
 * duplicate request key cannot allocate a second sequence and a lost release
 * race cannot seal a batch twice.
 */
export class PlaygroundStore {
  readonly #deps: PlaygroundDeps;

  constructor(orm: Orm, clock: () => Date = () => new Date()) {
    this.#deps = { orm, clock };
  }

  createRoom(input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  }): { readonly chatId: bigint; readonly conversationId: bigint; readonly members: readonly RoomMember[] } {
    return createRoom(this.#deps, input);
  }

  room(chatId: bigint): RoomState {
    return roomOf(this.#deps, chatId);
  }

  /**
   * The original admission of a request key, answered from the key's own row.
   *
   * The input row outlives the message and its pictures (retention keeps it as
   * a tombstone), so a lost response is answered here before any asset is
   * resolved: a replay never depends on rows that may already be gone.
   * Undefined means the key is new; a key used with other content is a conflict.
   */
  replaySubmission(
    chatId: bigint,
    input: {
      readonly requestKey: string;
      readonly senderId: bigint;
      readonly text: string;
      readonly replyToSeq?: bigint | null;
      readonly assetIds: readonly string[];
    },
  ): SubmitResult | undefined {
    return replaySubmission(this.#deps, chatId, input);
  }

  /**
   * Admit one room message.
   *
   * The sequence is allocated here and never reused. The same request key with
   * the same content returns the first admission; the same key with different
   * content is a conflict, because one key must not mean two messages.
   */
  submit(chatId: bigint, input: SubmitInput): SubmitResult {
    return submit(this.#deps, chatId, input);
  }

  /**
   * Seal every held input into one queued invocation.
   *
   * A release with no held inputs only closes the hold. The same release key
   * replays the first result; a different key at the same revision is refused
   * before it can seal the batch a second time.
   */
  release(chatId: bigint, input: ReleaseInput): ReleaseResult {
    return release(this.#deps, chatId, input);
  }

  /** Open a hold without admitting an input; used by the room UI. */
  hold(chatId: bigint): RoomState {
    return hold(this.#deps, chatId);
  }

  /**
   * Flip the room's image-generation switch.
   *
   * This is the only way a room may reach the paid image pipeline; the default
   * is off. The revision guard makes the write conflict with concurrent room
   * mutations, and the operator is recorded so a paid capability has an owner.
   * Setting the value it already has is a no-op: a retried request returns the
   * current state instead of failing on a stale revision it did not cause.
   */
  setImageEnabled(
    chatId: bigint,
    input: { readonly enabled: boolean; readonly actor: string; readonly revision: bigint },
  ): RoomState {
    return setImageEnabled(this.#deps, chatId, input);
  }

  /**
   * Retry a terminated, side-effect-free release attempt.
   *
   * The original invocation and its frozen snapshot stay untouched; a new
   * invocation is queued from copies of the snapshot rows. Anything that might
   * have reached a model, a tool, a send or a long task refuses the retry, and
   * a later release in the room refuses it too.
   */
  retry(chatId: bigint, input: RetryInput): RetryResult {
    return retry(this.#deps, chatId, input);
  }

  status(chatId: bigint): RoomStatus {
    return status(this.#deps, chatId);
  }

  /**
   * Every room with the counters a panel needs, newest first.
   *
   * The counters are per room, not per chat: a room owns exactly one
   * conversation, so "pending" means the held inputs of this room and
   * "queued/running" its invocations.
   */
  listRooms(): RoomSummary[] {
    return listRooms(this.#deps);
  }

  /** One room with the same counters `listRooms` reports. */
  roomSummary(chatId: bigint): RoomSummary {
    return roomSummaryOf(this.#deps, chatId);
  }

  /** The room's participants, oldest first. */
  members(chatId: bigint): RoomMember[] {
    return members(this.#deps, chatId);
  }

  /** Uploads that never became a message: disposable after the sweep window. */
  stagedAssets(chatId: bigint): StagedAsset[] {
    return stagedAssets(this.#deps, chatId);
  }

  /**
   * Create a room under a request key.
   *
   * A client that lost the response retries with the same key and gets the room
   * it created; the same key with a different body is a conflict. The key row is
   * written in the same transaction as the room, so a crash between them cannot
   * produce a room nobody can address.
   */
  createRoomWithKey(input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
    readonly requestKey: string;
  }): { readonly room: RoomSummary; readonly replayed: boolean } {
    return createRoomWithKey(this.#deps, input);
  }

  /**
   * Admit one virtual identity into a room under a request key.
   *
   * Names may repeat inside a room - identities are the senders, not the names -
   * so the key is the only thing that keeps a retried request from creating a
   * second identity. The key is scoped to the room it belongs to.
   */
  addParticipantWithKey(
    chatId: bigint,
    input: { readonly name: string; readonly role?: 'member' | 'admin'; readonly requestKey: string },
  ): { readonly member: RoomMember; readonly replayed: boolean } {
    return addParticipantWithKey(this.#deps, chatId, input);
  }

  /**
   * One page of the room timeline, newest first.
   *
   * `beforeSeq` pages backwards through the room's own sequence numbers, so a
   * page boundary is stable even while new messages arrive. Every entry carries
   * its input state (held/released/expired) or its send state, so the caller can
   * show a message that produced nothing without a second lookup.
   */
  timeline(
    chatId: bigint,
    options: { readonly beforeSeq?: bigint; readonly limit: number },
  ): { readonly items: readonly TimelineEntry[]; readonly hasMore: boolean } {
    return timeline(this.#deps, chatId, options);
  }

  /** One release with its attempts, sends and receipt state. */
  releaseDetail(chatId: bigint, releaseId: bigint): ReleaseDetail | undefined {
    return releaseDetail(this.#deps, chatId, releaseId);
  }

  /**
   * One invocation of this room, or undefined when that run belongs elsewhere.
   * A nested id is checked against the room it was asked through, never by
   * primary key alone.
   */
  roomInvocation(chatId: bigint, invocationId: bigint): RoomInvocationSummary | undefined {
    return roomInvocation(this.#deps, chatId, invocationId);
  }

  /** The room's invocations, newest first, with their usage and receipt state. */
  roomInvocations(chatId: bigint, limit: number): RoomInvocationSummary[] {
    return roomInvocations(this.#deps, chatId, limit);
  }

  /**
   * Expire queued room invocations that have waited too long.
   *
   * Only the room path is touched: Telegram collecting/debounce buckets keep
   * their own lifecycle. Expiry is visible in the status instead of silently
   * re-releasing anything.
   */
  expireQueued(now = this.#deps.clock(), ttlMilliseconds = PLAYGROUND_QUEUE_TTL_MS): number {
    return expireQueued(this.#deps, now, ttlMilliseconds);
  }

  /**
   * When the oldest queued room invocation becomes expirable, in epoch
   * milliseconds. A run that cannot launch (no free slot, its room busy) still
   * has to fail visibly on time, so the scheduler wakes for this deadline too.
   */
  nextQueuedExpiry(ttlMilliseconds = PLAYGROUND_QUEUE_TTL_MS): number | undefined {
    return nextQueuedExpiry(this.#deps, ttlMilliseconds);
  }
}
