/**
 * Reading one participant's profile, as far as the host's platform allows.
 *
 * This is a leaf module: it imports only identity types, so the platform can
 * describe a profile read without knowing a transport. How much of a profile
 * exists is a property of the platform, not of this contract: Telegram exposes
 * a member's standing, custom title, avatar and, in a private chat, a bio;
 * a virtual room knows only the display name and role it was created with.
 * A host therefore fills the fields it can and leaves the rest `null`.
 */

import type { ImConversationRef } from './identity.ts';

/** One member's profile as the host's platform can report it. */
export interface ImMemberProfile {
  /** Display name the platform shows; null when the platform exposes none. */
  readonly displayName: string | null;
  readonly username: string | null;
  readonly isBot: boolean | null;
  /** Host standing in this conversation, e.g. Telegram's `creator`/`member` or a room role. */
  readonly standing: string | null;
  /** Host-specific label on that standing, e.g. a Telegram custom title. */
  readonly title: string | null;
  /** Self-written description, when the platform exposes one for this scope. */
  readonly bio: string | null;
  readonly languageCode: string | null;
  /** When the platform records that this member joined; null when it does not. */
  readonly joinedAt: string | null;
  /**
   * Raw avatar bytes, unvalidated: the caller sniffs, normalizes and stores
   * them at the tool boundary, exactly like any other tool image.
   */
  readonly avatar: { readonly bytes: Uint8Array } | null;
}

/**
 * A profile read for one visible member of one conversation.
 *
 * `ref` is the token the model was shown (Telegram `uid:<id>`, a room
 * `member_<sender id>`), never a raw transport id chosen by the model. The
 * reader resolves it against the conversation it was bound to and returns
 * `null` when that ref is not a member of it.
 */
export interface ImMemberProfileRequest {
  readonly conversation: ImConversationRef;
  readonly ref: string;
  readonly signal: AbortSignal;
}

export interface ImMemberProfiles {
  read(request: ImMemberProfileRequest): Promise<ImMemberProfile | null>;
}
