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
 */
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { ROOM_SNAPSHOT_FORMAT } from '../context/context-builder.ts';
import { enqueueInvocation } from './invocation-enqueue.ts';
import type { Orm } from './store.ts';
import {
  buckets,
  chats,
  conversations,
  hostSends,
  invocationMessages,
  invocationBuckets,
  invocations,
  longTasks,
  messages,
  messageRevisions,
  modelCalls,
  media,
  playgroundAssets,
  playgroundInputs,
  playgroundMutations,
  playgroundReleases,
  playgroundRetries,
  roomParticipants,
  rooms,
  senders,
  taskReceipts,
  toolCalls,
} from './schema.ts';

export type PlaygroundErrorCode =
  | 'room_not_found'
  | 'room_not_held'
  | 'room_revision_mismatch'
  | 'input_conflict'
  | 'release_conflict'
  | 'retry_refused'
  | 'unknown_asset'
  | 'unknown_input'
  | 'unknown_release'
  | 'unknown_sender';

export class PlaygroundError extends Error {
  override readonly name = 'PlaygroundError';
  readonly code: PlaygroundErrorCode;
  constructor(code: PlaygroundErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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

const RELEASE_HISTORY_MESSAGES = 0;

/**
 * Room-local ingestion.
 *
 * All validation and writes happen inside one transaction per operation, so a
 * duplicate request key cannot allocate a second sequence and a lost release
 * race cannot seal a batch twice.
 */
export class PlaygroundStore {
  readonly #orm: Orm;
  readonly #clock: () => Date;

  constructor(orm: Orm, clock: () => Date = () => new Date()) {
    this.#orm = orm;
    this.#clock = clock;
  }

  createRoom(input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  }): { readonly chatId: bigint; readonly conversationId: bigint; readonly members: readonly RoomMember[] } {
    return this.#orm.transaction(() => this.#createRoomInside(input));
  }

  room(chatId: bigint): RoomState {
    const row = this.#roomRow(chatId);
    if (row === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return row;
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
    const fingerprint = fingerprintOf(input);
    return this.#orm.transaction(() => {
      if (this.#roomRow(chatId) === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      return this.#replayInside(chatId, input.requestKey, fingerprint);
    });
  }

  #replayInside(chatId: bigint, requestKey: string, fingerprint: string): SubmitResult | undefined {
    const existing = this.#orm
      .select({
        id: playgroundInputs.id,
        seq: playgroundInputs.seq,
        fingerprint: playgroundInputs.fingerprint,
        revision: rooms.revision,
      })
      .from(playgroundInputs)
      .innerJoin(rooms, eq(rooms.chatId, playgroundInputs.chatId))
      .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.requestKey, requestKey)))
      .get();
    if (existing === undefined) {
      return undefined;
    }
    if (existing.fingerprint !== fingerprint) {
      throw new PlaygroundError('input_conflict', `request key ${requestKey} was already used with different content`);
    }
    return { inputId: existing.id, seq: existing.seq, revision: existing.revision, admitted: false };
  }

  /**
   * Admit one room message.
   *
   * The sequence is allocated here and never reused. The same request key with
   * the same content returns the first admission; the same key with different
   * content is a conflict, because one key must not mean two messages.
   */
  submit(chatId: bigint, input: SubmitInput): SubmitResult {
    const now = this.#clock().toISOString();
    const fingerprint = fingerprintOf({ ...input, assetIds: (input.media ?? []).map((item) => item.assetId) });
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      const existing = this.#replayInside(chatId, input.requestKey, fingerprint);
      if (existing !== undefined) {
        return existing;
      }
      // Only a human member of this room may speak in it. The sender id comes
      // from the caller, so a foreign key alone would accept another room's
      // member, a Telegram sender or the bot itself.
      const member = this.#orm
        .select({ senderId: roomParticipants.senderId })
        .from(roomParticipants)
        .innerJoin(senders, eq(senders.id, roomParticipants.senderId))
        .where(
          and(
            eq(roomParticipants.chatId, chatId),
            eq(roomParticipants.senderId, input.senderId),
            eq(senders.hostKind, 'playground'),
            eq(senders.isBot, false),
          ),
        )
        .get();
      if (member === undefined) {
        throw new PlaygroundError('unknown_sender', `sender ${input.senderId} is not a member of room ${chatId}`);
      }
      for (const item of input.media ?? []) {
        const asset = this.#orm
          .select({ id: playgroundAssets.id })
          .from(playgroundAssets)
          .where(
            and(
              eq(playgroundAssets.id, item.assetId),
              eq(playgroundAssets.chatId, chatId),
              eq(playgroundAssets.sha256, item.sha256),
            ),
          )
          .get();
        if (asset === undefined) {
          throw new PlaygroundError('unknown_asset', `asset ${item.assetId} does not belong to room ${chatId}`);
        }
      }
      const seq = room.nextSeq;
      const replyMessageId =
        input.replyToSeq === null || input.replyToSeq === undefined
          ? null
          : this.#messageIdAtSeq(chatId, input.replyToSeq);
      if (input.replyToSeq !== null && input.replyToSeq !== undefined && replyMessageId === null) {
        throw new PlaygroundError('unknown_input', `room ${chatId} has no message at seq ${input.replyToSeq}`);
      }
      const message = this.#orm
        .insert(messages)
        .values({
          chatId,
          conversationId: room.conversationId,
          hostKind: 'playground',
          telegramMessageId: null,
          telegramDate: now,
          receivedAt: now,
          localSequenceNo: seq,
          localReplyToMessageId: replyMessageId,
        })
        .returning({ id: messages.id })
        .get();
      if (message === undefined) {
        throw new Error('failed to admit room message');
      }
      const revision = this.#orm
        .insert(messageRevisions)
        .values({
          messageId: message.id,
          revisionNo: 1n,
          kind: 'text',
          text: input.text,
          caption: null,
          senderId: input.senderId,
          createdAt: now,
          rawFragmentJson: '{}',
        })
        .returning({ id: messageRevisions.id })
        .get();
      if (revision === undefined) {
        throw new Error('failed to admit room revision');
      }
      // The message points at its own revision, exactly like a Telegram row:
      // readers (timeline, snapshots, audit) join on `current_revision_id`, so
      // a room input without it would be invisible to every one of them.
      this.#orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, message.id)).run();
      for (const item of input.media ?? []) {
        const mediaRow = this.#orm
          .insert(media)
          .values({
            revisionId: revision.id,
            kind: 'photo',
            fileId: `local:${item.assetId}`,
            fileUniqueId: `local:${chatId.toString()}:${item.sha256}`,
            mimeType: item.mime,
            fileSize: BigInt(item.byteSize),
            width: BigInt(item.width),
            height: BigInt(item.height),
            telegramJson: '{}',
            hostKind: 'playground',
            localAssetId: item.assetId,
          })
          .returning({ id: media.id })
          .get();
        if (mediaRow === undefined) {
          throw new Error('failed to link room media');
        }
        this.#orm
          .update(playgroundAssets)
          .set({ state: 'attached', mediaId: mediaRow.id, attachedAt: now })
          .where(eq(playgroundAssets.id, item.assetId))
          .run();
      }
      const inputRow = this.#orm
        .insert(playgroundInputs)
        .values({
          chatId,
          seq,
          requestKey: input.requestKey,
          fingerprint,
          messageId: message.id,
          revisionId: revision.id,
          state: 'held',
          createdAt: now,
        })
        .returning({ id: playgroundInputs.id })
        .get();
      if (inputRow === undefined) {
        throw new Error('failed to admit room input');
      }
      const revisionNo = room.revision + 1n;
      this.#orm
        .update(rooms)
        .set({
          nextSeq: seq + 1n,
          revision: revisionNo,
          // Every admitted input starts (or extends) a hold. A release closes
          // it; the next input opens a new one.
          hold: true,
          updatedAt: now,
        })
        .where(eq(rooms.chatId, chatId))
        .run();
      return { inputId: inputRow.id, seq, revision: revisionNo, admitted: true };
    });
  }

  /**
   * Seal every held input into one queued invocation.
   *
   * A release with no held inputs only closes the hold. The same release key
   * replays the first result; a different key at the same revision is refused
   * before it can seal the batch a second time.
   */
  release(chatId: bigint, input: ReleaseInput): ReleaseResult {
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      const existing = this.#orm
        .select()
        .from(playgroundReleases)
        .where(and(eq(playgroundReleases.chatId, chatId), eq(playgroundReleases.releaseKey, input.releaseKey)))
        .get();
      if (existing !== undefined) {
        return {
          releaseId: existing.id,
          throughSeq: existing.throughSeq,
          bucketId: existing.bucketId,
          invocationId: existing.invocationId,
          replayed: true,
        };
      }
      if (room.revision !== input.revision) {
        throw new PlaygroundError(
          'room_revision_mismatch',
          `room ${chatId} is at revision ${room.revision}, not ${input.revision}`,
        );
      }
      // One release per room revision. A competing release that reconciled the
      // same revision is refused here; the unique index catches the race that
      // slips past this read.
      const revisionTaken = this.#orm
        .select({ id: playgroundReleases.id })
        .from(playgroundReleases)
        .where(and(eq(playgroundReleases.chatId, chatId), eq(playgroundReleases.revision, room.revision)))
        .get();
      if (revisionTaken !== undefined) {
        throw new PlaygroundError('release_conflict', `room ${chatId} revision ${room.revision} was already released`);
      }
      if (!room.hold) {
        throw new PlaygroundError('room_not_held', `room ${chatId} has no open hold`);
      }
      const held = this.#orm
        .select({
          id: playgroundInputs.id,
          seq: playgroundInputs.seq,
          messageId: playgroundInputs.messageId,
          revisionId: playgroundInputs.revisionId,
        })
        .from(playgroundInputs)
        .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.state, 'held')))
        .orderBy(asc(playgroundInputs.seq))
        .all()
        .map((row) => {
          // The table refuses a held row without its message; this only
          // narrows the type for the snapshot below.
          if (row.messageId === null || row.revisionId === null) {
            throw new Error(`held room input ${row.seq} lost its message`);
          }
          return { id: row.id, seq: row.seq, messageId: row.messageId, revisionId: row.revisionId };
        });
      const throughSeq = held.at(-1)?.seq ?? 0n;
      // The caller states the boundary it saw. P0 seals the whole hold, so a
      // boundary that is not the room's latest admitted input means the caller
      // is looking at a stale room (another input landed, or a release already
      // ran): refuse instead of sealing more than it asked for. Bot output that
      // arrived meanwhile is not an input and does not move this boundary.
      const latestSeq = room.latestInputSeq;
      if (input.throughSeq !== undefined && input.throughSeq !== latestSeq) {
        throw new PlaygroundError(
          'release_conflict',
          `room ${chatId} has inputs through seq ${latestSeq}, not ${input.throughSeq}`,
        );
      }
      const release = this.#orm
        .insert(playgroundReleases)
        .values({
          chatId,
          releaseKey: input.releaseKey,
          revision: room.revision,
          throughSeq,
          createdAt: now,
        })
        .returning({ id: playgroundReleases.id })
        .get();
      if (release === undefined) {
        throw new PlaygroundError('release_conflict', `room ${chatId} revision ${room.revision} was already released`);
      }
      if (held.length === 0) {
        this.#orm.update(rooms).set({ hold: false, updatedAt: now }).where(eq(rooms.chatId, chatId)).run();
        return { releaseId: release.id, throughSeq, bucketId: null, invocationId: null, replayed: false };
      }
      const bucket = this.#orm
        .insert(buckets)
        .values({
          conversationId: room.conversationId,
          state: 'queued',
          kind: 'realtime',
          firstReceivedAt: now,
          deadlineAt: now,
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: buckets.id })
        .get();
      if (bucket === undefined) {
        throw new Error('failed to seal room bucket');
      }
      const invocationId = enqueueInvocation(this.#orm, {
        bucketId: bucket.id,
        conversationId: room.conversationId,
        configHash: 'playground',
        promptVersion: 1n,
        createdAt: now,
      });
      this.#writeSnapshot(chatId, bucket.id, invocationId, held);
      for (const entry of held) {
        this.#orm
          .update(playgroundInputs)
          .set({ state: 'released', releaseId: release.id, releasedAt: now })
          .where(eq(playgroundInputs.id, entry.id))
          .run();
      }
      this.#orm
        .update(playgroundReleases)
        .set({ bucketId: bucket.id, invocationId })
        .where(eq(playgroundReleases.id, release.id))
        .run();
      this.#orm.update(rooms).set({ hold: false, updatedAt: now }).where(eq(rooms.chatId, chatId)).run();
      return {
        releaseId: release.id,
        throughSeq,
        bucketId: bucket.id,
        invocationId,
        replayed: false,
      };
    });
  }

  /** Open a hold without admitting an input; used by the room UI. */
  hold(chatId: bigint): RoomState {
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      this.#orm
        .update(rooms)
        .set({ hold: true, revision: room.revision + 1n, updatedAt: now })
        .where(eq(rooms.chatId, chatId))
        .run();
      return { ...room, hold: true, revision: room.revision + 1n };
    });
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
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      if (room.imageEnabled === input.enabled) {
        return room;
      }
      if (room.revision !== input.revision) {
        throw new PlaygroundError(
          'room_revision_mismatch',
          `room ${chatId} is at revision ${room.revision}, not ${input.revision}`,
        );
      }
      const revision = room.revision + 1n;
      this.#orm
        .update(rooms)
        .set({
          imageEnabled: input.enabled,
          imageEnabledBy: input.actor,
          imageEnabledAt: now,
          revision,
          updatedAt: now,
        })
        .where(eq(rooms.chatId, chatId))
        .run();
      return { ...room, imageEnabled: input.enabled, imageEnabledBy: input.actor, imageEnabledAt: now, revision };
    });
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
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const existing = this.#orm
        .select()
        .from(playgroundRetries)
        .where(and(eq(playgroundRetries.chatId, chatId), eq(playgroundRetries.attemptKey, input.attemptKey)))
        .get();
      if (existing !== undefined) {
        // An attempt key names one retry of one release: the same key sent to
        // another release is a different request, not a lost response.
        if (existing.releaseId !== input.releaseId) {
          throw new PlaygroundError(
            'input_conflict',
            `attempt key ${input.attemptKey} was already used for release ${existing.releaseId}`,
          );
        }
        return {
          retryId: existing.id,
          invocationId: existing.invocationId,
          bucketId: this.#bucketIdOfInvocation(existing.invocationId),
          replayed: true,
        };
      }
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      const release = this.#orm
        .select()
        .from(playgroundReleases)
        .where(and(eq(playgroundReleases.id, input.releaseId), eq(playgroundReleases.chatId, chatId)))
        .get();
      if (release === undefined || release.invocationId === null) {
        throw new PlaygroundError('unknown_release', `release ${input.releaseId} has no invocation`);
      }
      const later = this.#orm
        .select({ id: playgroundReleases.id })
        .from(playgroundReleases)
        .where(and(eq(playgroundReleases.chatId, chatId), gt(playgroundReleases.id, release.id)))
        .get();
      if (later !== undefined) {
        throw new PlaygroundError('retry_refused', 'a later release exists in this room');
      }
      // Every guard below judges the release's latest attempt. The first
      // invocation stays failed after it was retried, so checking it again
      // would let a second attempt key queue the same batch twice.
      const latestRetry = this.#orm
        .select({ invocationId: playgroundRetries.invocationId })
        .from(playgroundRetries)
        .where(eq(playgroundRetries.releaseId, release.id))
        .orderBy(desc(playgroundRetries.id))
        .get();
      const attemptInvocationId = latestRetry?.invocationId ?? release.invocationId;
      const original = this.#orm.select().from(invocations).where(eq(invocations.id, attemptInvocationId)).get();
      if (original === undefined) {
        throw new PlaygroundError('unknown_release', `invocation ${attemptInvocationId} does not exist`);
      }
      // Only a known, terminated attempt may be retried. `outcome_unknown`
      // is exactly the case we must not double-run.
      if (original.state !== 'failed' && original.state !== 'aborted') {
        throw new PlaygroundError('retry_refused', `invocation is ${original.state}`);
      }
      if (original.sideEffectStarted || original.sendsUsed > 0n || original.toolCallsUsed > 0n) {
        throw new PlaygroundError('retry_refused', 'invocation started side effects');
      }
      const modelCall = this.#orm
        .select({ id: modelCalls.id })
        .from(modelCalls)
        .where(eq(modelCalls.invocationId, original.id))
        .get();
      if (modelCall !== undefined) {
        throw new PlaygroundError('retry_refused', 'invocation called a model');
      }
      const injected = this.#orm.all<{ count: bigint }>(
        sql`SELECT COUNT(*) AS count FROM context_messages WHERE invocation_id = ${original.id}`,
      )[0];
      if (injected !== undefined && Number(injected.count) > 0) {
        throw new PlaygroundError('retry_refused', 'invocation already injected context');
      }
      const sent = this.#orm.all<{ id: bigint }>(
        sql`SELECT hs.id FROM host_sends hs
            JOIN tool_calls tc ON tc.id = hs.tool_call_id
            WHERE tc.invocation_id = ${original.id}
            LIMIT 1`,
      )[0];
      if (sent !== undefined) {
        throw new PlaygroundError('retry_refused', 'invocation already sent a message');
      }
      const receipt = this.#orm
        .select({ id: taskReceipts.invocationId })
        .from(taskReceipts)
        .where(eq(taskReceipts.invocationId, original.id))
        .get();
      if (receipt !== undefined) {
        throw new PlaygroundError('retry_refused', 'invocation has a task receipt');
      }
      const longTask = this.#orm
        .select({ id: longTasks.id })
        .from(longTasks)
        .where(eq(longTasks.createdByInvocationId, original.id))
        .get();
      if (longTask !== undefined) {
        throw new PlaygroundError('retry_refused', 'invocation started a long task');
      }
      const bucket = this.#orm
        .insert(buckets)
        .values({
          conversationId: room.conversationId,
          state: 'queued',
          kind: 'realtime',
          firstReceivedAt: now,
          deadlineAt: now,
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: buckets.id })
        .get();
      if (bucket === undefined) {
        throw new Error('failed to seal retry bucket');
      }
      const invocationId = enqueueInvocation(this.#orm, {
        bucketId: bucket.id,
        conversationId: room.conversationId,
        configHash: original.configHash,
        promptVersion: original.promptVersion,
        createdAt: now,
      });
      // Copy the frozen snapshot. The retry must run the same messages, not
      // whatever is held now.
      this.#orm.run(
        sql`INSERT INTO invocation_messages
              (invocation_id, source_bucket_id, sequence_no, message_id, revision_id, section, snapshot_json, snapshot_format)
            SELECT ${invocationId}, ${bucket.id}, sequence_no, message_id, revision_id, section, snapshot_json, snapshot_format
            FROM invocation_messages WHERE invocation_id = ${original.id}`,
      );
      const retry = this.#orm
        .insert(playgroundRetries)
        .values({
          chatId,
          releaseId: release.id,
          invocationId,
          retryOfInvocationId: original.id,
          attemptKey: input.attemptKey,
          createdAt: now,
        })
        .returning({ id: playgroundRetries.id })
        .get();
      if (retry === undefined) {
        throw new Error('failed to record retry');
      }
      return { retryId: retry.id, invocationId, bucketId: bucket.id, replayed: false };
    });
  }

  status(chatId: bigint): RoomStatus {
    const room = this.room(chatId);
    const held = this.#orm
      .select({
        inputId: playgroundInputs.id,
        seq: playgroundInputs.seq,
        messageId: messageRevisions.messageId,
        senderId: messageRevisions.senderId,
        text: messageRevisions.text,
        createdAt: playgroundInputs.createdAt,
      })
      .from(playgroundInputs)
      .innerJoin(messageRevisions, eq(messageRevisions.id, playgroundInputs.revisionId))
      .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.state, 'held')))
      .orderBy(asc(playgroundInputs.seq))
      .all()
      .map((row) => ({
        inputId: row.inputId,
        seq: row.seq,
        messageId: row.messageId,
        senderId: row.senderId ?? 0n,
        text: row.text ?? '',
        createdAt: row.createdAt,
      }));
    const releases = this.#orm
      .select({
        id: playgroundReleases.id,
        revision: playgroundReleases.revision,
        throughSeq: playgroundReleases.throughSeq,
        invocationId: playgroundReleases.invocationId,
        createdAt: playgroundReleases.createdAt,
      })
      .from(playgroundReleases)
      .where(eq(playgroundReleases.chatId, chatId))
      .orderBy(asc(playgroundReleases.id))
      .all()
      .map((row) => {
        const invocation =
          row.invocationId === null
            ? undefined
            : this.#orm
                .select({ state: invocations.state, errorCode: invocations.errorCode })
                .from(invocations)
                .where(eq(invocations.id, row.invocationId))
                .get();
        return {
          ...row,
          invocationState: invocation?.state ?? null,
          invocationErrorCode: invocation?.errorCode ?? null,
        };
      });
    const expiredInputs =
      this.#orm
        .select({ count: count() })
        .from(playgroundInputs)
        .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.state, 'expired')))
        .get()?.count ?? 0;
    return { ...room, held, expiredInputs, releases };
  }

  /**
   * Every room with the counters a panel needs, newest first.
   *
   * The counters are per room, not per chat: a room owns exactly one
   * conversation, so "pending" means the held inputs of this room and
   * "queued/running" its invocations.
   */
  listRooms(): RoomSummary[] {
    return this.#roomSummaries(undefined);
  }

  /** One room with the same counters `listRooms` reports. */
  roomSummary(chatId: bigint): RoomSummary {
    const summary = this.#roomSummaries(chatId)[0];
    if (summary === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return summary;
  }

  #roomSummaries(chatId: bigint | undefined): RoomSummary[] {
    return this.#orm
      .select({
        chatId: rooms.chatId,
        conversationId: conversations.id,
        title: sql<string>`coalesce(${chats.title}, '')`,
        revision: rooms.revision,
        hold: rooms.hold,
        nextSeq: rooms.nextSeq,
        latestInputSeq: latestInputSeqOf(rooms.chatId),
        imageEnabled: rooms.imageEnabled,
        imageEnabledBy: rooms.imageEnabledBy,
        imageEnabledAt: rooms.imageEnabledAt,
        createdAt: rooms.createdAt,
        memberCount: sql<bigint>`(SELECT COUNT(*) FROM room_participants p WHERE p.chat_id = ${rooms.chatId})`,
        heldCount: sql<bigint>`(SELECT COUNT(*) FROM playground_inputs i WHERE i.chat_id = ${rooms.chatId} AND i.state = 'held')`,
        queuedInvocations: sql<bigint>`(SELECT COUNT(*) FROM invocations iv WHERE iv.conversation_id = ${conversations.id} AND iv.state = 'queued')`,
        runningInvocations: sql<bigint>`(SELECT COUNT(*) FROM invocations iv WHERE iv.conversation_id = ${conversations.id} AND iv.state = 'running')`,
      })
      .from(rooms)
      .innerJoin(chats, eq(chats.id, rooms.chatId))
      .innerJoin(conversations, eq(conversations.chatId, rooms.chatId))
      .where(chatId === undefined ? undefined : eq(rooms.chatId, chatId))
      .orderBy(desc(rooms.chatId))
      .all()
      .map((row) => ({
        ...row,
        memberCount: Number(row.memberCount),
        heldCount: Number(row.heldCount),
        queuedInvocations: Number(row.queuedInvocations),
        runningInvocations: Number(row.runningInvocations),
      }));
  }

  /** The room's participants, oldest first. */
  members(chatId: bigint): RoomMember[] {
    if (this.#roomRow(chatId) === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return this.#orm
      .select({ senderId: roomParticipants.senderId, name: senders.displayName, role: roomParticipants.role })
      .from(roomParticipants)
      .innerJoin(senders, eq(senders.id, roomParticipants.senderId))
      .where(eq(roomParticipants.chatId, chatId))
      .orderBy(asc(roomParticipants.senderId))
      .all()
      .map((row) => ({
        senderId: row.senderId,
        name: row.name,
        role: row.role === 'admin' ? 'admin' : 'member',
      }));
  }

  /** Uploads that never became a message: disposable after the sweep window. */
  stagedAssets(chatId: bigint): StagedAsset[] {
    return this.#orm
      .select({
        assetId: playgroundAssets.id,
        mime: playgroundAssets.mime,
        byteSize: playgroundAssets.byteSize,
        sha256: playgroundAssets.sha256,
        createdAt: playgroundAssets.createdAt,
      })
      .from(playgroundAssets)
      .where(and(eq(playgroundAssets.chatId, chatId), eq(playgroundAssets.state, 'staged')))
      .orderBy(asc(playgroundAssets.createdAt))
      .all()
      .map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
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
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          title: input.title,
          members: (input.members ?? []).map((member) => ({ name: member.name, role: member.role ?? 'member' })),
        }),
      )
      .digest('hex');
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const existing = this.#orm
        .select()
        .from(playgroundMutations)
        .where(
          and(
            eq(playgroundMutations.kind, 'room'),
            eq(playgroundMutations.roomChatId, 0n),
            eq(playgroundMutations.requestKey, input.requestKey),
          ),
        )
        .get();
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new PlaygroundError(
            'input_conflict',
            `request key ${input.requestKey} was already used with different content`,
          );
        }
        // The replay reports the room as it is now, counters included.
        return { room: this.roomSummary(BigInt(existing.resultJson)), replayed: true };
      }
      const created = this.#createRoomInside(input);
      this.#orm
        .insert(playgroundMutations)
        .values({
          kind: 'room',
          roomChatId: 0n,
          requestKey: input.requestKey,
          fingerprint,
          resultJson: created.chatId.toString(),
          createdAt: now,
        })
        .run();
      return { room: this.roomSummary(created.chatId), replayed: false };
    });
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
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ name: input.name, role: input.role ?? 'member' }))
      .digest('hex');
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      const existing = this.#orm
        .select()
        .from(playgroundMutations)
        .where(
          and(
            eq(playgroundMutations.kind, 'participant'),
            eq(playgroundMutations.roomChatId, chatId),
            eq(playgroundMutations.requestKey, input.requestKey),
          ),
        )
        .get();
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new PlaygroundError(
            'input_conflict',
            `request key ${input.requestKey} was already used with different content`,
          );
        }
        const member = this.#orm
          .select({ senderId: roomParticipants.senderId, role: roomParticipants.role, name: senders.displayName })
          .from(roomParticipants)
          .innerJoin(senders, eq(senders.id, roomParticipants.senderId))
          .where(and(eq(roomParticipants.chatId, chatId), eq(roomParticipants.senderId, BigInt(existing.resultJson))))
          .get();
        if (member === undefined) {
          throw new PlaygroundError('unknown_sender', `participant ${existing.resultJson} is gone from room ${chatId}`);
        }
        return {
          member: { senderId: member.senderId, name: member.name, role: member.role === 'admin' ? 'admin' : 'member' },
          replayed: true,
        };
      }
      const member = this.#createParticipantInside(chatId, input.name, input.role ?? 'member', now);
      this.#orm
        .insert(playgroundMutations)
        .values({
          kind: 'participant',
          roomChatId: chatId,
          requestKey: input.requestKey,
          fingerprint,
          resultJson: member.senderId.toString(),
          createdAt: now,
        })
        .run();
      return { member, replayed: false };
    });
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
    const rows = this.#orm
      .select({
        messageId: messages.id,
        seq: messages.localSequenceNo,
        sentByBot: messages.sentByBot,
        receivedAt: messages.receivedAt,
        kind: messageRevisions.kind,
        text: messageRevisions.text,
        caption: messageRevisions.caption,
        senderId: messageRevisions.senderId,
        senderName: senders.displayName,
        senderIsBot: senders.isBot,
        replyToMessageId: messages.localReplyToMessageId,
        replyToSeq: sql<
          bigint | null
        >`(SELECT m2.local_sequence_no FROM messages m2 WHERE m2.id = ${messages.localReplyToMessageId})`,
        inputState: sql<string | null>`(SELECT i.state FROM playground_inputs i WHERE i.message_id = ${messages.id})`,
        sendState: sql<string | null>`(SELECT hs.state FROM host_sends hs WHERE hs.message_id = ${messages.id})`,
      })
      .from(messages)
      .innerJoin(messageRevisions, eq(messageRevisions.id, messages.currentRevisionId))
      .leftJoin(senders, eq(senders.id, messageRevisions.senderId))
      .where(
        and(
          eq(messages.chatId, chatId),
          sql`${messages.localSequenceNo} IS NOT NULL`,
          options.beforeSeq === undefined ? undefined : lt(messages.localSequenceNo, options.beforeSeq),
        ),
      )
      .orderBy(desc(messages.localSequenceNo))
      .limit(options.limit + 1)
      .all();
    const page = rows.slice(0, options.limit);
    // One media query per page, then each entry takes only its own pictures.
    const mediaByMessage = Map.groupBy(
      this.#timelineMedia(page.map((entry) => entry.messageId)),
      (item) => item.messageId,
    );
    const items = page.map((row) => ({
      messageId: row.messageId,
      seq: row.seq ?? 0n,
      sentByBot: row.sentByBot,
      createdAt: row.receivedAt,
      kind: row.kind,
      text: row.text,
      caption: row.caption,
      senderId: row.senderId,
      senderName: row.senderName,
      senderIsBot: row.senderIsBot === true,
      replyToMessageId: row.replyToMessageId,
      replyToSeq: row.replyToSeq,
      inputState: row.inputState,
      sendState: row.sendState,
      media: mediaByMessage.get(row.messageId) ?? [],
    }));
    return { items, hasMore: rows.length > options.limit };
  }

  /** One release with its attempts, sends and receipt state. */
  releaseDetail(chatId: bigint, releaseId: bigint): ReleaseDetail | undefined {
    const release = this.#orm
      .select()
      .from(playgroundReleases)
      .where(and(eq(playgroundReleases.id, releaseId), eq(playgroundReleases.chatId, chatId)))
      .get();
    if (release === undefined) {
      return undefined;
    }
    const retries = this.#orm
      .select({ invocationId: playgroundRetries.invocationId })
      .from(playgroundRetries)
      .where(eq(playgroundRetries.releaseId, releaseId))
      .orderBy(asc(playgroundRetries.id))
      .all();
    const invocationIds = [release.invocationId, ...retries.map((row) => row.invocationId)].filter(
      (id): id is bigint => id !== null,
    );
    return {
      release: {
        id: release.id,
        revision: release.revision,
        throughSeq: release.throughSeq,
        bucketId: release.bucketId,
        invocationId: release.invocationId,
        createdAt: release.createdAt,
      },
      attempts: invocationIds.map((invocationId) => this.#invocationSummary(invocationId)),
      sends: this.#releaseSends(invocationIds),
    };
  }

  /**
   * One invocation of this room, or undefined when that run belongs elsewhere.
   * A nested id is checked against the room it was asked through, never by
   * primary key alone.
   */
  roomInvocation(chatId: bigint, invocationId: bigint): RoomInvocationSummary | undefined {
    const room = this.#roomRow(chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    const row = this.#orm
      .select({ id: invocations.id })
      .from(invocations)
      .where(and(eq(invocations.id, invocationId), eq(invocations.conversationId, room.conversationId)))
      .get();
    return row === undefined ? undefined : this.#invocationSummary(row.id);
  }

  /** The room's invocations, newest first, with their usage and receipt state. */
  roomInvocations(chatId: bigint, limit: number): RoomInvocationSummary[] {
    const room = this.#roomRow(chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return this.#orm
      .select({ id: invocations.id })
      .from(invocations)
      .where(eq(invocations.conversationId, room.conversationId))
      .orderBy(desc(invocations.id))
      .limit(limit)
      .all()
      .map((row) => this.#invocationSummary(row.id));
  }

  #createRoomInside(input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  }): { readonly chatId: bigint; readonly conversationId: bigint; readonly members: readonly RoomMember[] } {
    const now = this.#clock().toISOString();
    const chat = this.#orm
      .insert(chats)
      .values({
        hostKind: 'playground',
        type: 'group',
        title: input.title,
        telegramChatId: null,
        canonicalChatId: null,
        updatedAt: now,
      })
      .returning({ id: chats.id })
      .get();
    if (chat === undefined) {
      throw new Error('failed to create room chat');
    }
    this.#orm
      .insert(rooms)
      .values({ chatId: chat.id, revision: 1n, nextSeq: 1n, hold: true, createdAt: now, updatedAt: now })
      .run();
    const conversation = this.#orm
      .insert(conversations)
      .values({ chatId: chat.id, messageThreadId: 0n, createdAt: now, updatedAt: now })
      .returning({ id: conversations.id })
      .get();
    if (conversation === undefined) {
      throw new Error('failed to create room conversation');
    }
    const members: RoomMember[] = [];
    for (const member of input.members ?? []) {
      members.push(this.#createParticipantInside(chat.id, member.name, member.role ?? 'member', now));
    }
    return { chatId: chat.id, conversationId: conversation.id, members };
  }

  #createParticipantInside(chatId: bigint, name: string, role: 'member' | 'admin', now: string): RoomMember {
    const sender = this.#orm
      .insert(senders)
      .values({
        hostKind: 'playground',
        telegramId: null,
        telegramType: null,
        displayName: name,
        username: null,
        isBot: false,
        updatedAt: now,
      })
      .returning({ id: senders.id })
      .get();
    if (sender === undefined) {
      throw new Error('failed to create room member');
    }
    this.#orm.insert(roomParticipants).values({ chatId, senderId: sender.id, role, joinedAt: now }).run();
    return { senderId: sender.id, name, role };
  }

  #timelineMedia(messageIds: readonly bigint[]): TimelineMedia[] {
    if (messageIds.length === 0) {
      return [];
    }
    return (
      this.#orm
        .select({
          messageId: messageRevisions.messageId,
          id: media.id,
          kind: media.kind,
          mimeType: media.mimeType,
          fileUniqueId: media.fileUniqueId,
          width: media.width,
          height: media.height,
          assetId: media.localAssetId,
        })
        .from(media)
        .innerJoin(messageRevisions, eq(messageRevisions.id, media.revisionId))
        // Only the revision the entry shows: an edited message's older pictures
        // are history, not part of what the timeline renders.
        .innerJoin(messages, eq(messages.currentRevisionId, messageRevisions.id))
        .where(inArray(messageRevisions.messageId, [...messageIds]))
        .orderBy(asc(media.id))
        .all()
    );
  }

  #releaseSends(invocationIds: readonly bigint[]): readonly ReleaseSend[] {
    if (invocationIds.length === 0) {
      return [];
    }
    return this.#orm
      .select({
        id: hostSends.id,
        invocationId: toolCalls.invocationId,
        kind: hostSends.kind,
        state: hostSends.state,
        messageId: hostSends.messageId,
        errorCode: hostSends.errorCode,
        createdAt: hostSends.createdAt,
        finishedAt: hostSends.finishedAt,
      })
      .from(hostSends)
      .innerJoin(toolCalls, eq(toolCalls.id, hostSends.toolCallId))
      .where(inArray(toolCalls.invocationId, [...invocationIds]))
      .orderBy(asc(hostSends.id))
      .all();
  }

  #invocationSummary(invocationId: bigint): RoomInvocationSummary {
    const row = this.#orm.select().from(invocations).where(eq(invocations.id, invocationId)).get();
    if (row === undefined) {
      throw new PlaygroundError('unknown_release', `invocation ${invocationId} does not exist`);
    }
    const usage = this.#orm.all<{ total_tokens: bigint; total_cost: number | null }>(
      sql`SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)), 0) AS total_tokens,
                 SUM(cost) AS total_cost
          FROM model_calls WHERE invocation_id = ${invocationId}`,
    )[0];
    const receipt = this.#orm
      .select({ state: taskReceipts.state, status: taskReceipts.status })
      .from(taskReceipts)
      .where(eq(taskReceipts.invocationId, invocationId))
      .get();
    const retryOf = this.#orm
      .select({ retryOfInvocationId: playgroundRetries.retryOfInvocationId })
      .from(playgroundRetries)
      .where(eq(playgroundRetries.invocationId, invocationId))
      .get();
    return {
      id: row.id,
      state: row.state,
      errorCode: row.errorCode,
      completionReason: row.completionReason,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      sendsUsed: Number(row.sendsUsed),
      toolCallsUsed: Number(row.toolCallsUsed),
      sideEffectStarted: row.sideEffectStarted,
      totalTokens: Number(usage?.total_tokens ?? 0n),
      totalCost: usage?.total_cost ?? null,
      receiptState: receipt?.state ?? null,
      receiptStatus: receipt?.status ?? null,
      retryOfInvocationId: retryOf?.retryOfInvocationId ?? null,
    };
  }

  /**
   * Expire queued room invocations that have waited too long.
   *
   * Only the room path is touched: Telegram collecting/debounce buckets keep
   * their own lifecycle. Expiry is visible in the status instead of silently
   * re-releasing anything.
   */
  expireQueued(now = this.#clock(), ttlMilliseconds = 5 * 60_000): number {
    const cutoff = new Date(now.getTime() - ttlMilliseconds).toISOString();
    const rows = this.#orm
      .select({ id: invocations.id, bucketId: buckets.id })
      .from(invocations)
      .innerJoin(buckets, eq(buckets.id, invocations.bucketId))
      .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(and(eq(chats.hostKind, 'playground'), eq(invocations.state, 'queued'), lt(invocations.createdAt, cutoff)))
      .all();
    for (const row of rows) {
      this.#orm
        .update(invocations)
        .set({ state: 'failed', finishedAt: now.toISOString(), errorCode: 'queued_expired' })
        .where(eq(invocations.id, row.id))
        .run();
      this.#orm
        .update(buckets)
        .set({
          state: 'expired',
          errorCode: 'queued_expired',
          finishedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .where(eq(buckets.id, row.bucketId))
        .run();
    }
    return rows.length;
  }

  #roomRow(chatId: bigint): RoomState | undefined {
    return this.#orm
      .select({
        chatId: rooms.chatId,
        conversationId: conversations.id,
        title: sql<string>`coalesce(${chats.title}, '')`,
        revision: rooms.revision,
        hold: rooms.hold,
        nextSeq: rooms.nextSeq,
        latestInputSeq: latestInputSeqOf(rooms.chatId),
        imageEnabled: rooms.imageEnabled,
        imageEnabledBy: rooms.imageEnabledBy,
        imageEnabledAt: rooms.imageEnabledAt,
      })
      .from(rooms)
      .innerJoin(chats, eq(chats.id, rooms.chatId))
      .innerJoin(conversations, eq(conversations.chatId, rooms.chatId))
      .where(eq(rooms.chatId, chatId))
      .get();
  }

  #messageIdAtSeq(chatId: bigint, seq: bigint): bigint | null {
    return (
      this.#orm
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.localSequenceNo, seq)))
        .get()?.id ?? null
    );
  }

  #bucketIdOfInvocation(invocationId: bigint): bigint {
    return (
      this.#orm
        .select({ bucketId: invocationBuckets.bucketId })
        .from(invocationBuckets)
        .where(eq(invocationBuckets.invocationId, invocationId))
        .get()?.bucketId ?? 0n
    );
  }

  #writeSnapshot(
    chatId: bigint,
    bucketId: bigint,
    invocationId: bigint,
    held: readonly { readonly seq: bigint; readonly messageId: bigint; readonly revisionId: bigint }[],
  ): void {
    let index = 0n;
    if (RELEASE_HISTORY_MESSAGES > 0) {
      throw new Error('room history snapshots are not implemented yet');
    }
    for (const entry of held) {
      const row = this.#orm
        .select({
          kind: messageRevisions.kind,
          text: messageRevisions.text,
          caption: messageRevisions.caption,
          senderId: messageRevisions.senderId,
          senderName: senders.displayName,
          role: roomParticipants.role,
          receivedAt: messages.receivedAt,
          replyToSeq: sql<
            bigint | null
          >`(SELECT m2.local_sequence_no FROM messages m2 WHERE m2.id = ${messages.localReplyToMessageId})`,
        })
        .from(messageRevisions)
        .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
        .innerJoin(senders, eq(senders.id, messageRevisions.senderId))
        .leftJoin(
          roomParticipants,
          and(eq(roomParticipants.chatId, chatId), eq(roomParticipants.senderId, messageRevisions.senderId)),
        )
        .where(eq(messageRevisions.id, entry.revisionId))
        .get();
      if (row === undefined) {
        throw new Error(`room input ${entry.seq} lost its revision`);
      }
      const mediaRows = this.#orm
        .select({
          id: media.id,
          kind: media.kind,
          fileUniqueId: media.fileUniqueId,
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
        })
        .from(media)
        .where(eq(media.revisionId, entry.revisionId))
        .orderBy(asc(media.id))
        .all();
      index += 1n;
      this.#orm
        .insert(invocationMessages)
        .values({
          invocationId,
          sourceBucketId: bucketId,
          sequenceNo: index,
          messageId: entry.messageId,
          revisionId: entry.revisionId,
          section: 'new',
          snapshotJson: JSON.stringify({
            host: 'playground',
            message_id: entry.seq.toString(),
            // When the member said it, not when the hold was released: a
            // batch held for hours must not read as one burst.
            sent_at: row.receivedAt,
            sent_by_bot: false,
            revision: '1',
            sender: {
              ref: `member_${row.senderId ?? 0n}`,
              name: row.senderName,
              role: row.role ?? 'member',
            },
            kind: row.kind,
            text: row.text,
            caption: row.caption,
            reply_to_message_id: row.replyToSeq === null ? null : row.replyToSeq.toString(),
            reply_snapshot: null,
            media: mediaRows.map((item) => ({
              id: item.id.toString(),
              kind: item.kind,
              file_unique_id: item.fileUniqueId,
              mime_type: item.mimeType,
              width: item.width === null ? null : item.width.toString(),
              height: item.height === null ? null : item.height.toString(),
            })),
          }),
          snapshotFormat: ROOM_SNAPSHOT_FORMAT,
        })
        .run();
    }
  }
}

/** Seq of a room's latest admitted input in any state; 0 before the first. */
function latestInputSeqOf(chatId: typeof rooms.chatId) {
  return sql<bigint>`coalesce((SELECT MAX(pi.seq) FROM playground_inputs pi WHERE pi.chat_id = ${chatId}), 0)`;
}

/**
 * A submission's semantic fields. Pictures are named by the asset ids the
 * caller sent: an id names exactly one (room, content) pair, and unlike the
 * asset row it survives in the request itself after retention removed the row.
 */
function fingerprintOf(input: {
  readonly senderId: bigint;
  readonly text: string;
  readonly replyToSeq?: bigint | null;
  readonly assetIds: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        senderId: input.senderId.toString(),
        text: input.text,
        replyToSeq: input.replyToSeq?.toString() ?? null,
        assetIds: input.assetIds,
      }),
    )
    .digest('hex');
}
