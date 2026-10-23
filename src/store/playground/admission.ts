/**
 * Admitting a room message: replay of a lost response, the sequence
 * allocation, and the fingerprint that decides whether a request key is the
 * same message or a different one.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SubmitInput, SubmitResult } from '../playground.ts';
import {
  media,
  messageRevisions,
  messages,
  playgroundAssets,
  playgroundInputs,
  roomParticipants,
  rooms,
  senders,
} from '../schema.ts';
import { PlaygroundError, type PlaygroundDeps, roomRow } from './shared.ts';

export function replaySubmission(
  deps: PlaygroundDeps,
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
  return deps.orm.transaction(() => {
    if (roomRow(deps, chatId) === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    return replayInside(deps, chatId, input.requestKey, fingerprint);
  });
}

function replayInside(
  deps: PlaygroundDeps,
  chatId: bigint,
  requestKey: string,
  fingerprint: string,
): SubmitResult | undefined {
  const existing = deps.orm
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

export function submit(deps: PlaygroundDeps, chatId: bigint, input: SubmitInput): SubmitResult {
  const now = deps.clock().toISOString();
  const fingerprint = fingerprintOf({ ...input, assetIds: (input.media ?? []).map((item) => item.assetId) });
  return deps.orm.transaction(() => {
    const room = roomRow(deps, chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    const existing = replayInside(deps, chatId, input.requestKey, fingerprint);
    if (existing !== undefined) {
      return existing;
    }
    // Only a human member of this room may speak in it. The sender id comes
    // from the caller, so a foreign key alone would accept another room's
    // member, a Telegram sender or the bot itself.
    const member = deps.orm
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
      const asset = deps.orm
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
        : messageIdAtSeq(deps, chatId, input.replyToSeq);
    if (input.replyToSeq !== null && input.replyToSeq !== undefined && replyMessageId === null) {
      throw new PlaygroundError('unknown_input', `room ${chatId} has no message at seq ${input.replyToSeq}`);
    }
    const message = deps.orm
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
    const revision = deps.orm
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
    deps.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, message.id)).run();
    for (const item of input.media ?? []) {
      const mediaRow = deps.orm
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
      deps.orm
        .update(playgroundAssets)
        .set({ state: 'attached', mediaId: mediaRow.id, attachedAt: now })
        .where(eq(playgroundAssets.id, item.assetId))
        .run();
    }
    const inputRow = deps.orm
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
    deps.orm
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

function messageIdAtSeq(deps: PlaygroundDeps, chatId: bigint, seq: bigint): bigint | null {
  return (
    deps.orm
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.localSequenceNo, seq)))
      .get()?.id ?? null
  );
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
