/**
 * Room and participant creation, keyed or not, and the participant list.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { RoomMember, RoomSummary } from './index.ts';
import { chats, conversations, playgroundMutations, roomParticipants, rooms, senders } from '../schema/index.ts';
import { PlaygroundError, type PlaygroundDeps, roomRow, roomSummaryOf } from './shared.ts';

export function createRoom(
  deps: PlaygroundDeps,
  input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  },
): { readonly chatId: bigint; readonly conversationId: bigint; readonly members: readonly RoomMember[] } {
  return deps.orm.transaction(() => createRoomInside(deps, input));
}

export function createRoomWithKey(
  deps: PlaygroundDeps,
  input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
    readonly requestKey: string;
  },
): { readonly room: RoomSummary; readonly replayed: boolean } {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        title: input.title,
        members: (input.members ?? []).map((member) => ({ name: member.name, role: member.role ?? 'member' })),
      }),
    )
    .digest('hex');
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const existing = deps.orm
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
      return { room: roomSummaryOf(deps, BigInt(existing.resultJson)), replayed: true };
    }
    const created = createRoomInside(deps, input);
    deps.orm
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
    return { room: roomSummaryOf(deps, created.chatId), replayed: false };
  });
}

export function addParticipantWithKey(
  deps: PlaygroundDeps,
  chatId: bigint,
  input: { readonly name: string; readonly role?: 'member' | 'admin'; readonly requestKey: string },
): { readonly member: RoomMember; readonly replayed: boolean } {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ name: input.name, role: input.role ?? 'member' }))
    .digest('hex');
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const room = roomRow(deps, chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    const existing = deps.orm
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
      const member = deps.orm
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
    const member = createParticipantInside(deps, chatId, input.name, input.role ?? 'member', now);
    deps.orm
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

function createRoomInside(
  deps: PlaygroundDeps,
  input: {
    readonly title: string;
    readonly members?: readonly { readonly name: string; readonly role?: 'member' | 'admin' }[];
  },
): { readonly chatId: bigint; readonly conversationId: bigint; readonly members: readonly RoomMember[] } {
  const now = deps.clock().toISOString();
  const chat = deps.orm
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
  deps.orm
    .insert(rooms)
    .values({ chatId: chat.id, revision: 1n, nextSeq: 1n, hold: true, createdAt: now, updatedAt: now })
    .run();
  const conversation = deps.orm
    .insert(conversations)
    .values({ chatId: chat.id, messageThreadId: 0n, createdAt: now, updatedAt: now })
    .returning({ id: conversations.id })
    .get();
  if (conversation === undefined) {
    throw new Error('failed to create room conversation');
  }
  const members: RoomMember[] = [];
  for (const member of input.members ?? []) {
    members.push(createParticipantInside(deps, chat.id, member.name, member.role ?? 'member', now));
  }
  return { chatId: chat.id, conversationId: conversation.id, members };
}

function createParticipantInside(
  deps: PlaygroundDeps,
  chatId: bigint,
  name: string,
  role: 'member' | 'admin',
  now: string,
): RoomMember {
  const sender = deps.orm
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
  deps.orm.insert(roomParticipants).values({ chatId, senderId: sender.id, role, joinedAt: now }).run();
  return { senderId: sender.id, name, role };
}

export function members(deps: PlaygroundDeps, chatId: bigint): RoomMember[] {
  if (roomRow(deps, chatId) === undefined) {
    throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
  }
  return deps.orm
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
