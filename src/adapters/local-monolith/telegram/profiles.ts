/**
 * Member profiles on Telegram, as far as the Bot API exposes them.
 *
 * Three calls, each answering a different half of a profile:
 *
 * - `getChatMember` is the only source of a member's standing and custom title,
 *   and the only one that works in a group where the bot may not see the whole
 *   chat. It is guaranteed only while the bot is an administrator; a plain
 *   member's `getChatMember` is refused by Telegram, so its failure is a
 *   partial profile, not a failed read.
 * - `getChat` fills a private chat's bio and username. In a group it describes
 *   the group, never a person, so it is only asked for a one-to-one
 *   conversation.
 * - `getUserProfilePhotos` returns file ids; the bytes come from the media
 *   client, exactly like every other picture this process downloads.
 *
 * Telegram hides what it hides: a member with a hidden profile answers with
 * less, and nothing here invents the difference. A ref the conversation never
 * showed is refused before any call leaves the process.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { ChatFullInfo, ChatMember, UserProfilePhotos } from 'grammy/types';
import type { MediaDownloader } from '../../../capabilities/media/download.ts';
import type { SenderId } from '../../../platform/im-host/identity.ts';
import type { ImMemberProfile, ImMemberProfileRequest, ImMemberProfiles } from '../../../platform/im-host/profiles.ts';
import type { BusinessStore } from '../../../store/store.ts';

/**
 * The subset of the Bot API this reader asks for, so a test can stand in for
 * it. The signatures are grammy's own, so a cancelled tool call cancels the
 * request in flight instead of waiting for its timeout.
 */
export type TelegramProfileApi = Pick<Api, 'getChatMember' | 'getChat' | 'getUserProfilePhotos'>;

/** grammY still types its abort signal as the older abort-controller shim; it forwards abort events. */
type GrammySignal = Parameters<Api['getChat']>[1];
const grammySignal = (signal: AbortSignal): GrammySignal => signal as unknown as GrammySignal;

export interface TelegramProfileOptions {
  readonly api: TelegramProfileApi;
  /**
   * The conversation's own history, which is what authorizes a read: a uid the
   * chat never showed is refused before any Bot API call, so a model cannot
   * probe arbitrary Telegram accounts through this process.
   */
  readonly store: BusinessStore;
  readonly download: MediaDownloader;
  /** The configured media cache; one avatar download gets a private directory under it. */
  readonly mediaCache: () => string;
  /** Newest avatar variant only; the model gets one picture, not a gallery. */
  readonly avatarMaxBytes?: number;
}

const DEFAULT_AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/** `uid:123` is the only shape the Telegram host renders. */
export function parseTelegramSenderRef(ref: string): SenderId | null {
  const match = /^uid:([1-9][0-9]*)$/.exec(ref);
  const digits = match?.[1];
  if (digits === undefined) {
    return null;
  }
  const value = Number(digits);
  return Number.isSafeInteger(value) ? (BigInt(digits) as SenderId) : null;
}

/** The newest profile photo at its largest size, downloaded; null when there is none. */
async function readAvatar(
  options: TelegramProfileOptions,
  userId: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array } | null> {
  let photos: UserProfilePhotos;
  try {
    photos = await options.api.getUserProfilePhotos(userId, { limit: 1 }, grammySignal(signal));
  } catch {
    // A user who hides their photos answers with an error instead of an empty
    // list on some API versions; that is a missing avatar, not a failed read.
    signal.throwIfAborted();
    return null;
  }
  const largest = photos.photos[0]?.at(-1);
  if (largest === undefined) {
    return null;
  }
  if (largest.file_size !== undefined && largest.file_size > (options.avatarMaxBytes ?? DEFAULT_AVATAR_MAX_BYTES)) {
    return null;
  }
  const cache = options.mediaCache();
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, 'profile-'));
  try {
    const destination = join(directory, 'avatar');
    await options.download.download(largest.file_id, destination, signal);
    return { bytes: new Uint8Array(await readFile(destination, { signal })) };
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function joinedName(parts: readonly (string | undefined)[]): string | null {
  const name = parts.filter((part) => part !== undefined && part.length > 0).join(' ');
  return name.length === 0 ? null : name;
}

/** Whether this conversation ever carried a message from that Telegram user. */
function knownMember(store: BusinessStore, conversationId: bigint, userId: bigint): boolean {
  const row = store.orm.get<{ present: number }>(sql`
    SELECT 1 AS present
    FROM messages m
    JOIN message_revisions r ON r.id = m.current_revision_id
    JOIN senders s ON s.id = r.sender_id
    WHERE m.conversation_id = ${conversationId} AND s.telegram_type = 'user' AND s.telegram_id = ${userId}
    LIMIT 1`);
  return row !== undefined;
}

export function createTelegramProfiles(options: TelegramProfileOptions): ImMemberProfiles {
  return {
    async read(request: ImMemberProfileRequest): Promise<ImMemberProfile | null> {
      const { conversation, signal } = request;
      const senderId = parseTelegramSenderRef(request.ref);
      if (conversation.host !== 'telegram' || senderId === null) {
        return null;
      }
      const userId = Number(senderId);
      if (!Number.isSafeInteger(userId) || !knownMember(options.store, conversation.id, senderId)) {
        return null;
      }
      signal.throwIfAborted();
      const chatId = conversation.chatId.toString();
      let member: ChatMember | undefined;
      try {
        member = await options.api.getChatMember(chatId, userId, grammySignal(signal));
      } catch {
        signal.throwIfAborted();
      }
      // A private chat is the other person, so its bio and names describe the
      // requested member only when that member is the other person — the bot's
      // own outgoing messages put the bot's uid in this history too.
      let chat: ChatFullInfo | undefined;
      if (conversation.scope === 'private' && chatId === senderId.toString()) {
        try {
          chat = await options.api.getChat(chatId, grammySignal(signal));
        } catch {
          signal.throwIfAborted();
        }
      }
      const avatar = await readAvatar(options, userId, signal);
      signal.throwIfAborted();
      const privateChat = chat?.type === 'private' ? chat : undefined;
      const person = member?.user;
      return {
        displayName:
          joinedName([person?.first_name, person?.last_name]) ??
          joinedName([privateChat?.first_name, privateChat?.last_name]),
        username: person?.username ?? privateChat?.username ?? null,
        isBot: person?.is_bot ?? null,
        standing: member?.status ?? null,
        title: member !== undefined && 'custom_title' in member ? (member.custom_title ?? null) : null,
        bio: privateChat?.bio ?? null,
        languageCode: person?.language_code ?? null,
        joinedAt: null,
        avatar,
      };
    },
  };
}
