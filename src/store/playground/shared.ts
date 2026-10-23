/**
 * Vocabulary shared by every playground store operation: the error codes, the
 * collaborator pair, and the room row reads that all of them start from.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { RoomState, RoomSummary } from '../playground.ts';
import { chats, conversations, rooms } from '../schema.ts';
import type { Orm } from '../store.ts';

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

/** The two collaborators every playground store operation needs. */
export interface PlaygroundDeps {
  readonly orm: Orm;
  readonly clock: () => Date;
}

export function roomRow(deps: PlaygroundDeps, chatId: bigint): RoomState | undefined {
  return deps.orm
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

/** Seq of a room's latest admitted input in any state; 0 before the first. */
export function latestInputSeqOf(chatId: typeof rooms.chatId) {
  return sql<bigint>`coalesce((SELECT MAX(pi.seq) FROM playground_inputs pi WHERE pi.chat_id = ${chatId}), 0)`;
}

export function roomOf(deps: PlaygroundDeps, chatId: bigint): RoomState {
  const row = roomRow(deps, chatId);
  if (row === undefined) {
    throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
  }
  return row;
}

export function roomSummariesOf(deps: PlaygroundDeps, chatId: bigint | undefined): RoomSummary[] {
  return deps.orm
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

export function roomSummaryOf(deps: PlaygroundDeps, chatId: bigint): RoomSummary {
  const summary = roomSummariesOf(deps, chatId)[0];
  if (summary === undefined) {
    throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
  }
  return summary;
}
