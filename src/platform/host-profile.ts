import { HOST_KINDS, type HostKind } from './im-host/identity.ts';

/** `daily_usage.scope` a host's spend accumulates into. */
export type BudgetScope = 'chat' | 'playground';

/** The `invocation_messages.snapshot_format` a Telegram snapshot writer freezes. */
export const TELEGRAM_SNAPSHOT_FORMAT = 'plasticwan.invocation-snapshot.v1';
/** The `invocation_messages.snapshot_format` the Playground release path freezes. */
export const ROOM_SNAPSHOT_FORMAT = 'plasticwan.invocation-snapshot.playground.v1';

/**
 * Model-visible wording one host owns. Every prompt byte that differs between
 * hosts lives here rather than in a `kind ===` branch, so a string is audited
 * in exactly one place and a new host cannot inherit another host's phrasing.
 */
export interface HostWording {
  /** Tag wrapping the untrusted history block in the rendered injection. */
  readonly historyTag: string;
  /** Noun phrase the system prompt uses for the host's image sources. */
  readonly imageSources: string;
  /** `read_image` tool label. */
  readonly readImageLabel: string;
  /** `read_image` description: what one img_ reference names. */
  readonly readImageOrigin: string;
  /** `read_image` description: the trailing ref-usage sentence. */
  readonly readImageRefNote: string;
  /** `read_member_profile` tool label. */
  readonly memberProfileLabel: string;
  /** `read_member_profile` description: the member ref format to pass. */
  readonly memberFormat: string;
  /** `read_member_profile` description: what the host can expose. */
  readonly memberProfileNote: string;
}

/**
 * The fixed execution profile of a host.
 *
 * A host is not a chat "mode": it is an identity, and it decides once which
 * real capabilities an invocation may reach. Telegram keeps the full palette;
 * the Playground is deliberately narrow, and anything not named here is denied
 * instead of inherited from the Telegram configuration.
 *
 * Core code reads a trait (`hostExecutionProfile(kind).sleep`) or runs an
 * exhaustive `switch (kind)`; it never compares against a host literal.
 */
export interface HostExecutionProfile {
  readonly kind: HostKind;
  /** Media rows of this host may be read as image input. */
  readonly mediaRead: boolean;
  /** Sticker index and sticker search capabilities. */
  readonly stickers: boolean;
  /** Host-level MCP servers (web search included). */
  readonly mcp: boolean;
  /** `zzz` and the global sleep window. */
  readonly sleep: boolean;
  /** `daily_usage.scope` this host accumulates into. */
  readonly budgetScope: BudgetScope;
  /** Task completions may carry `bypassDailyBudget`. */
  readonly budgetBypass: boolean;
  /** Skills that never appear for this host. */
  readonly hiddenSkills: readonly string[];
  /**
   * Where a chat's configuration comes from: a `config` chat resolves a
   * `telegram.chats` entry by the host's own chat id; a `room` chat is created
   * at runtime and addressed by its internal chat id.
   */
  readonly chatSource: 'config' | 'room';
  /**
   * How user work reaches an invocation: `bucket` collects debounced messages
   * and expires stale ones on recovery; `release` holds a room queue whose
   * expiry the room store itself reports.
   */
  readonly intake: 'bucket' | 'release';
  /**
   * What a send result reports: `wire` ids the host's own transport assigned,
   * or the `sequence` number of the record the host published itself.
   */
  readonly deliveryRecord: 'wire' | 'sequence';
  /** Where a media row's bytes come from: a host `download`, or a `local_asset`. */
  readonly mediaSource: 'download' | 'local_asset';
  /** Whether the host holds a process connection (`registry`) or is always usable (`none`). */
  readonly connection: 'registry' | 'none';
  /** The `invocation_messages.snapshot_format` this host's writer produces. */
  readonly snapshotFormat: string;
  /** Model-visible wording; see {@link HostWording}. */
  readonly wording: HostWording;
}

export const TELEGRAM_PROFILE: HostExecutionProfile = {
  kind: 'telegram',
  mediaRead: true,
  stickers: true,
  mcp: true,
  sleep: true,
  budgetScope: 'chat',
  budgetBypass: true,
  hiddenSkills: [],
  chatSource: 'config',
  intake: 'bucket',
  deliveryRecord: 'wire',
  mediaSource: 'download',
  connection: 'registry',
  snapshotFormat: TELEGRAM_SNAPSHOT_FORMAT,
  wording: {
    historyTag: 'untrusted_telegram_history',
    imageSources: 'Telegram images and Stickers',
    readImageLabel: 'Read Telegram image',
    readImageOrigin: 'Telegram Photo, image Document, or Sticker',
    readImageRefNote:
      ' img_ refs are read-only and MUST NOT be sent as stickers; to send a sticker, you MUST call search_stickers first for a stk_ sticker_ref.',
    memberProfileLabel: 'Read Telegram member profile',
    memberFormat: '`uid:<n>`',
    memberProfileNote:
      'Telegram reports standing and a custom title only while the bot is an administrator, and a bio only in a private chat; the newest profile photo comes back as an attached image.',
  },
};

export const PLAYGROUND_PROFILE: HostExecutionProfile = {
  kind: 'playground',
  mediaRead: true,
  stickers: false,
  mcp: false,
  sleep: false,
  budgetScope: 'playground',
  budgetBypass: false,
  // The image skill is not listed: a room sees it exactly when its image
  // switch is on, which the runtime decides per conversation.
  hiddenSkills: ['alarms', 'dictionary', 'sticker-search'],
  chatSource: 'room',
  intake: 'release',
  deliveryRecord: 'sequence',
  mediaSource: 'local_asset',
  connection: 'none',
  snapshotFormat: ROOM_SNAPSHOT_FORMAT,
  wording: {
    historyTag: 'untrusted_room_history',
    imageSources: 'images posted in the room',
    readImageLabel: 'Read room image',
    readImageOrigin: 'image uploaded to this room',
    readImageRefNote: ' img_ refs are read-only.',
    memberProfileLabel: 'Read room member profile',
    memberFormat: '`member:member_<n>` (the bare `member_<n>` is accepted too)',
    memberProfileNote:
      'A room knows only the display name, role and join time it was created with; there are no avatars or bios.',
  },
};

const PROFILES: Record<HostKind, HostExecutionProfile> = {
  telegram: TELEGRAM_PROFILE,
  playground: PLAYGROUND_PROFILE,
};

export function hostExecutionProfile(kind: HostKind): HostExecutionProfile {
  return PROFILES[kind];
}

/** The hosts whose profile satisfies `predicate`, in `HOST_KINDS` order. */
export function hostsWhere(predicate: (profile: HostExecutionProfile) => boolean): readonly HostKind[] {
  return HOST_KINDS.filter((kind) => predicate(PROFILES[kind]));
}

/**
 * The host whose `mcp` trait is on. MCP bindings only ever resolve for that
 * host's chats, so registry-time previews validate as that host.
 */
export function mcpCapableHost(): HostKind {
  const host = hostsWhere((profile) => profile.mcp).at(0);
  if (host === undefined) {
    throw new Error('No MCP-capable host kind');
  }
  return host;
}

/**
 * The chat id a policy scope uses for one stored row: a `config` chat is
 * addressed by its host-native id, a `room` chat by its internal chat id.
 * Neither is ever used as the other's id.
 */
export function policyScopeChatId(
  kind: HostKind,
  ids: { readonly hostChatId: bigint | null; readonly chatId: bigint },
): bigint {
  switch (PROFILES[kind].chatSource) {
    case 'config':
      return ids.hostChatId ?? 0n;
    case 'room':
      return ids.chatId;
  }
}
