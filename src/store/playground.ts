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
import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { ROOM_SNAPSHOT_FORMAT } from '../context/context-builder.ts';
import { enqueueInvocation } from './invocation-enqueue.ts';
import type { Orm } from './store.ts';
import {
  buckets,
  chats,
  conversations,
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
  playgroundReleases,
  playgroundRetries,
  roomParticipants,
  rooms,
  senders,
  taskReceipts,
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
    const now = this.#clock().toISOString();
    return this.#orm.transaction(() => {
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
        const sender = this.#orm
          .insert(senders)
          .values({
            hostKind: 'playground',
            telegramId: null,
            telegramType: null,
            displayName: member.name,
            username: null,
            isBot: false,
            updatedAt: now,
          })
          .returning({ id: senders.id })
          .get();
        if (sender === undefined) {
          throw new Error('failed to create room member');
        }
        this.#orm
          .insert(roomParticipants)
          .values({
            chatId: chat.id,
            senderId: sender.id,
            role: member.role ?? 'member',
            joinedAt: now,
          })
          .run();
        members.push({ senderId: sender.id, name: member.name, role: member.role ?? 'member' });
      }
      return { chatId: chat.id, conversationId: conversation.id, members };
    });
  }

  room(chatId: bigint): RoomState {
    const row = this.#roomRow(chatId);
    if (row === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return row;
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
    const fingerprint = fingerprintOf(input);
    return this.#orm.transaction(() => {
      const room = this.#roomRow(chatId);
      if (room === undefined) {
        throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
      }
      const existing = this.#orm
        .select({
          id: playgroundInputs.id,
          seq: playgroundInputs.seq,
          fingerprint: playgroundInputs.fingerprint,
          revision: rooms.revision,
        })
        .from(playgroundInputs)
        .innerJoin(rooms, eq(rooms.chatId, playgroundInputs.chatId))
        .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.requestKey, input.requestKey)))
        .get();
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new PlaygroundError(
            'input_conflict',
            `request key ${input.requestKey} was already used with different content`,
          );
        }
        return {
          inputId: existing.id,
          seq: existing.seq,
          revision: existing.revision,
          admitted: false,
        };
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

function fingerprintOf(input: SubmitInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        senderId: input.senderId.toString(),
        text: input.text,
        replyToSeq: input.replyToSeq?.toString() ?? null,
        media: (input.media ?? []).map((item) => item.sha256),
      }),
    )
    .digest('hex');
}
