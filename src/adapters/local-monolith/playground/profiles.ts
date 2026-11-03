/**
 * Member profiles in a virtual room.
 *
 * A room identity is not a Telegram user: it exists only as a `senders` row
 * admitted to specific rooms, so there is nothing to ask a platform about. What
 * a room can report is exactly what it was created with — display name, the
 * membership role, and when the member joined — plus the bot's own username
 * when the runtime has one. There is no avatar and no bio, and this reader does
 * not pretend otherwise.
 */

import { and, eq } from 'drizzle-orm';
import type { ImMemberProfile, ImMemberProfileRequest, ImMemberProfiles } from '../../../platform/im-host/profiles.ts';
import { roomParticipants, senders } from '../../../store/schema/index.ts';
import type { BusinessStore } from '../../../store/store.ts';

/**
 * A room header renders `member:member_<sender row id>`, and the tool also
 * accepts the bare `member_<id>` so the model can quote either half of that
 * token. Nothing else is addressable.
 */
export function parseRoomSenderRef(ref: string): bigint | null {
  const match = /^(?:member:)?member_([1-9][0-9]*)$/.exec(ref);
  return match?.[1] === undefined ? null : BigInt(match[1]);
}

export interface RoomProfileOptions {
  readonly store: BusinessStore;
  /** The bot's own room identity, for the one member whose username exists. */
  readonly self: { readonly displayName: string; readonly username?: string | null };
}

export function createRoomProfiles(options: RoomProfileOptions): ImMemberProfiles {
  return {
    async read(request: ImMemberProfileRequest): Promise<ImMemberProfile | null> {
      request.signal.throwIfAborted();
      const senderId = parseRoomSenderRef(request.ref);
      if (request.conversation.host !== 'playground' || senderId === null) {
        return null;
      }
      // The membership row is the authorization: a sender id from another room
      // resolves to nothing. `chatId` is the room's internal chat id, which is
      // what a playground conversation ref carries (it has no wire id).
      const row = options.store.orm
        .select({
          displayName: senders.displayName,
          isBot: senders.isBot,
          joinedAt: roomParticipants.joinedAt,
          role: roomParticipants.role,
        })
        .from(roomParticipants)
        .innerJoin(senders, eq(senders.id, roomParticipants.senderId))
        .where(
          and(
            eq(roomParticipants.chatId, BigInt(request.conversation.chatId)),
            eq(roomParticipants.senderId, senderId),
          ),
        )
        .get();
      if (row === undefined) {
        return null;
      }
      const isSelf = row.isBot && row.displayName === options.self.displayName;
      return {
        displayName: row.displayName,
        username: isSelf ? (options.self.username ?? null) : null,
        isBot: row.isBot,
        standing: row.role,
        title: null,
        bio: null,
        languageCode: null,
        joinedAt: row.joinedAt,
        avatar: null,
      };
    },
  };
}
