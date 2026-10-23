/**
 * What a panel reads: the room's held inputs and releases, its counters, its
 * staged uploads, and the expiry clock of queued room runs.
 */
import { and, asc, count, eq, lt, sql } from 'drizzle-orm';
import type { RoomState, RoomStatus, RoomSummary, StagedAsset } from '../playground.ts';
import {
  buckets,
  chats,
  conversations,
  invocations,
  messageRevisions,
  playgroundAssets,
  playgroundInputs,
  playgroundReleases,
  rooms,
} from '../schema.ts';
import { PlaygroundError, type PlaygroundDeps, roomOf, roomRow, roomSummariesOf } from './shared.ts';

export function status(deps: PlaygroundDeps, chatId: bigint): RoomStatus {
  const room = roomOf(deps, chatId);
  const held = deps.orm
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
  const releases = deps.orm
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
          : deps.orm
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
    deps.orm
      .select({ count: count() })
      .from(playgroundInputs)
      .where(and(eq(playgroundInputs.chatId, chatId), eq(playgroundInputs.state, 'expired')))
      .get()?.count ?? 0;
  return { ...room, held, expiredInputs, releases };
}

export function hold(deps: PlaygroundDeps, chatId: bigint): RoomState {
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const room = roomRow(deps, chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    deps.orm
      .update(rooms)
      .set({ hold: true, revision: room.revision + 1n, updatedAt: now })
      .where(eq(rooms.chatId, chatId))
      .run();
    return { ...room, hold: true, revision: room.revision + 1n };
  });
}

export function setImageEnabled(
  deps: PlaygroundDeps,
  chatId: bigint,
  input: { readonly enabled: boolean; readonly actor: string; readonly revision: bigint },
): RoomState {
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const room = roomRow(deps, chatId);
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
    deps.orm
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

export function listRooms(deps: PlaygroundDeps): RoomSummary[] {
  return roomSummariesOf(deps, undefined);
}

export function stagedAssets(deps: PlaygroundDeps, chatId: bigint): StagedAsset[] {
  return deps.orm
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

export function expireQueued(deps: PlaygroundDeps, now: Date, ttlMilliseconds: number): number {
  const cutoff = new Date(now.getTime() - ttlMilliseconds).toISOString();
  const rows = deps.orm
    .select({ id: invocations.id, bucketId: buckets.id })
    .from(invocations)
    .innerJoin(buckets, eq(buckets.id, invocations.bucketId))
    .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(eq(chats.hostKind, 'playground'), eq(invocations.state, 'queued'), lt(invocations.createdAt, cutoff)))
    .all();
  for (const row of rows) {
    deps.orm
      .update(invocations)
      .set({ state: 'failed', finishedAt: now.toISOString(), errorCode: 'queued_expired' })
      .where(eq(invocations.id, row.id))
      .run();
    deps.orm
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

export function nextQueuedExpiry(deps: PlaygroundDeps, ttlMilliseconds: number): number | undefined {
  const oldest = deps.orm
    .select({ createdAt: sql<string | null>`min(${invocations.createdAt})` })
    .from(invocations)
    .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(eq(chats.hostKind, 'playground'), eq(invocations.state, 'queued')))
    .get()?.createdAt;
  // `expireQueued` takes rows strictly older than the cutoff.
  return oldest === null || oldest === undefined ? undefined : Date.parse(oldest) + ttlMilliseconds + 1;
}
