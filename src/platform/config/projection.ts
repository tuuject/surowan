/**
 * The configuration projection: the only place core code learns how a host's
 * configured pieces map onto the file's sections.
 *
 * `config.telegram` stays the file shape and the Admin surface, but nothing
 * outside this module, the configuration adapters, the host's own adapters and
 * the product API may read it. Every core reader goes through the accessors
 * here, so adding a host means adding a section and one branch per accessor
 * rather than auditing a hundred `config.telegram` reads.
 *
 * The projection is deliberately thin: it never merges, defaults or rewrites
 * values. Chat entries come out exactly as the file declares them, and the
 * intake settings are the section's own fields under a host-neutral name.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { telegramChatIdentity } from '../../store/chat-identity.ts';
import { chatMigrations, chats } from '../../store/schema/index.ts';
import type { BusinessStore, Orm } from '../../store/store.ts';
import { hostExecutionProfile, hostsWhere } from '../host-profile.ts';
import { type HostKind, unreachableHostKind } from '../im-host/identity.ts';
import type {
  ChatConfigEntry,
  DecisionGateConfig,
  ParticipationConfig,
  ProactiveReplyConfig,
  RawConfig,
} from './index.ts';
import { type BucketTiming, resolveBucketTiming } from './resolve.ts';

/** Identity a configured-chat lookup is keyed by: the host plus its own chat id. */
export interface ChatConfigRef {
  readonly hostKind: HostKind;
  /** The host's native chat id; `null` for a chat the host addresses internally. */
  readonly hostChatId: bigint | null;
}

/** The configured chat entries of one host, in file order; a room host has none. */
export function configuredChats(config: RawConfig, host: HostKind): readonly ChatConfigEntry[] {
  switch (host) {
    case 'telegram':
      return config.telegram.chats;
    case 'playground':
      return [];
    default: {
      const unreachable: never = host;
      return unreachable;
    }
  }
}

/** Every configured chat entry across hosts, each tagged with its owning host. */
export function allConfiguredChats(
  config: RawConfig,
): readonly { readonly host: HostKind; readonly chat: ChatConfigEntry }[] {
  return hostsWhere((profile) => profile.chatSource === 'config').flatMap((host) =>
    configuredChats(config, host).map((chat) => ({ host, chat })),
  );
}

/**
 * Maps every configured chat entry through `map` and returns the new config.
 * Only chat entries change; every other field is shared with the input.
 */
export function mapConfiguredChats(
  config: RawConfig,
  map: (chat: ChatConfigEntry, host: HostKind) => ChatConfigEntry,
): RawConfig {
  let next = config;
  for (const host of hostsWhere((profile) => profile.chatSource === 'config')) {
    next = mapHostChats(next, host, map);
  }
  return next;
}

function mapHostChats(
  config: RawConfig,
  host: HostKind,
  map: (chat: ChatConfigEntry, host: HostKind) => ChatConfigEntry,
): RawConfig {
  switch (host) {
    case 'telegram':
      return {
        ...config,
        telegram: {
          ...config.telegram,
          chats: config.telegram.chats.map((chat) => map(chat, host)),
        },
      };
    case 'playground':
      return config;
    default: {
      const unreachable: never = host;
      return unreachable;
    }
  }
}

/**
 * The intake-facing settings of one host: the knobs a host's own ingestion and
 * intake paths read. They are the section's fields under fixed names — a host
 * without that section (a room) gets the neutral values, never another host's.
 */
export interface HostIntakeSettings {
  readonly bucketTiming: BucketTiming;
  readonly process_bot_messages: boolean;
  readonly sticker_trigger_enabled: boolean | undefined;
  readonly mention_typing_enabled: boolean | undefined;
  readonly participation: ParticipationConfig | undefined;
  readonly proactive_reply: ProactiveReplyConfig | undefined;
  readonly decision_gate: DecisionGateConfig | undefined;
  readonly admins: readonly number[];
}

export function hostIntakeSettings(config: RawConfig, host: HostKind): HostIntakeSettings {
  switch (host) {
    case 'telegram':
      return {
        bucketTiming: resolveBucketTiming(config, host),
        process_bot_messages: config.telegram.process_bot_messages,
        sticker_trigger_enabled: config.telegram.sticker_trigger_enabled,
        mention_typing_enabled: config.telegram.mention_typing_enabled,
        participation: config.telegram.participation,
        proactive_reply: config.telegram.proactive_reply,
        decision_gate: config.telegram.decision_gate,
        admins: config.telegram.admins ?? [],
      };
    case 'playground':
      return {
        bucketTiming: resolveBucketTiming(config, host),
        process_bot_messages: false,
        sticker_trigger_enabled: undefined,
        mention_typing_enabled: undefined,
        participation: undefined,
        proactive_reply: undefined,
        decision_gate: undefined,
        admins: [],
      };
    default: {
      const unreachable: never = host;
      return unreachable;
    }
  }
}

/**
 * The configured chat entry a chat resolves to, or `undefined` when it has
 * none: a `room` chat never has one, and a `config` chat without a host-native
 * id or without a matching entry is unconfigured by definition.
 *
 * The dispatch is by the host's `chatSource` trait; what follows the trait is
 * the host's own branch. Telegram's `chat_migrations` alias resolution lives in
 * its branch: a migrated supergroup resolves the entry authored for the
 * predecessor id, exactly as before.
 */
export function resolveChatConfig(config: RawConfig, orm: Orm, chat: ChatConfigRef): ChatConfigEntry | undefined {
  if (hostExecutionProfile(chat.hostKind).chatSource !== 'config' || chat.hostChatId === null) {
    return undefined;
  }
  const hostChatId = chat.hostChatId;
  switch (chat.hostKind) {
    case 'telegram': {
      const direct = config.telegram.chats.find((entry) => BigInt(entry.id) === hostChatId);
      if (direct !== undefined) {
        return direct;
      }
      const migration = orm
        .select({ oldChatId: chatMigrations.oldChatId })
        .from(chatMigrations)
        .where(eq(chatMigrations.newChatId, hostChatId))
        .get();
      return migration === undefined
        ? undefined
        : config.telegram.chats.find((entry) => BigInt(entry.id) === migration.oldChatId);
    }
    case 'playground':
      return undefined;
    default: {
      const unreachable: never = chat.hostKind;
      return unreachable;
    }
  }
}

/**
 * Stored chat rows one configured Chat entry resolves to, under its host's own
 * identity rule. The per-host dispatch keeps Telegram's `chat_migrations`
 * alias graph at this boundary: a migrated supergroup matches on the
 * predecessor id as well. A `room` host can never be addressed from the file,
 * so it contributes no stored row.
 */
export function storedChatsForConfig(
  store: BusinessStore,
  host: HostKind,
  configuredId: bigint,
): readonly { id: bigint; hostChatId: bigint }[] {
  switch (host) {
    case 'telegram': {
      const nativeIds = telegramChatIdentity(store, [configuredId]);
      return store.orm
        .select({ id: chats.id, hostChatId: chats.hostChatId })
        .from(chats)
        .where(and(eq(chats.hostKind, 'telegram'), inArray(chats.hostChatId, nativeIds)))
        .all()
        .map((row) => ({ id: row.id, hostChatId: row.hostChatId as bigint }));
    }
    case 'playground':
      return [];
    default:
      return unreachableHostKind(host);
  }
}
