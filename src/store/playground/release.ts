/**
 * Sealing a hold into one queued invocation, plus the frozen snapshot the run
 * reads instead of live rows.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { enqueueInvocation } from '../invocation-enqueue.ts';
import type { ReleaseInput, ReleaseResult } from '../playground.ts';
import {
  buckets,
  invocationMessages,
  media,
  messageRevisions,
  messages,
  playgroundInputs,
  playgroundReleases,
  roomParticipants,
  rooms,
  senders,
} from '../schema.ts';
import { PlaygroundError, type PlaygroundDeps, roomRow } from './shared.ts';
import { ROOM_SNAPSHOT_FORMAT } from '../../context/context-builder-schema.ts';

const RELEASE_HISTORY_MESSAGES = 0;

export function release(deps: PlaygroundDeps, chatId: bigint, input: ReleaseInput): ReleaseResult {
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const room = roomRow(deps, chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    const existing = deps.orm
      .select()
      .from(playgroundReleases)
      .where(and(eq(playgroundReleases.chatId, chatId), eq(playgroundReleases.releaseKey, input.releaseKey)))
      .get();
    if (existing !== undefined) {
      // A replay names the revision it released; the same key at another
      // revision is a new Release under a used key, and answering it with
      // the old result would leave the newer inputs held.
      if (existing.revision !== input.revision) {
        throw new PlaygroundError(
          'input_conflict',
          `release key ${input.releaseKey} was already used at revision ${existing.revision}`,
        );
      }
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
    const revisionTaken = deps.orm
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
    const held = deps.orm
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
    const release = deps.orm
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
      deps.orm.update(rooms).set({ hold: false, updatedAt: now }).where(eq(rooms.chatId, chatId)).run();
      return { releaseId: release.id, throughSeq, bucketId: null, invocationId: null, replayed: false };
    }
    const bucket = deps.orm
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
    const invocationId = enqueueInvocation(deps.orm, {
      bucketId: bucket.id,
      conversationId: room.conversationId,
      configHash: 'playground',
      promptVersion: 1n,
      createdAt: now,
    });
    writeSnapshot(deps, chatId, bucket.id, invocationId, held);
    for (const entry of held) {
      deps.orm
        .update(playgroundInputs)
        .set({ state: 'released', releaseId: release.id, releasedAt: now })
        .where(eq(playgroundInputs.id, entry.id))
        .run();
    }
    deps.orm
      .update(playgroundReleases)
      .set({ bucketId: bucket.id, invocationId })
      .where(eq(playgroundReleases.id, release.id))
      .run();
    deps.orm.update(rooms).set({ hold: false, updatedAt: now }).where(eq(rooms.chatId, chatId)).run();
    return {
      releaseId: release.id,
      throughSeq,
      bucketId: bucket.id,
      invocationId,
      replayed: false,
    };
  });
}

function writeSnapshot(
  deps: PlaygroundDeps,
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
    const row = deps.orm
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
    const mediaRows = deps.orm
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
    deps.orm
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
