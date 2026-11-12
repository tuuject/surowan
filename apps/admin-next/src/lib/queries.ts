import { infiniteQueryOptions, type Query, queryOptions } from '@tanstack/react-query';
import { listApiKeys, listBotAdmins } from './api/admin.ts';
import { listAlarms } from './api/alarms.ts';
import { getSession, listPasskeys } from './api/auth.ts';
import { getChats } from './api/chats.ts';
import { getConfigStatus, getDeveloperSettings, getHarnessSettings } from './api/config.ts';
import { getConversationContext, listConversationContexts } from './api/contexts.ts';
import type { ListFilters, Page } from './api/core.ts';
import type { DictionaryScope } from './api/dictionary.ts';
import { getDictionarySettings, listDictionary, listDictionaryChats } from './api/dictionary.ts';
import { listGroupMemories } from './api/group-memories.ts';
import { getInvocation, listInvocations } from './api/invocations.ts';
import { listMemories, listMemoryChats } from './api/memories.ts';
import { getMessage, listMessages } from './api/messages.ts';
import {
  getPlaygroundRelease,
  getPlaygroundRoom,
  listPlaygroundInvocations,
  listPlaygroundMessages,
  listPlaygroundRooms,
} from './api/playground.ts';
import type { PromptScopeRef } from './api/prompts.ts';
import { getPromptDiff, getPromptDocument, getPromptVersions } from './api/prompts.ts';
import { getProviderPresets, getProviders } from './api/providers.ts';
import { listStickerSets, listStickers } from './api/stickers.ts';
import { getTelegram } from './api/telegram.ts';
import { getOverview, getUsage } from './api/usage.ts';
import { getVersion } from './api/version.ts';
import { listWarnings } from './api/warnings.ts';

export const PAGE_SIZE = 25;
/** How often an open list asks whether rows arrived after its snapshot. */
export const LIST_POLL_MS = 15_000;

/**
 * Which rows a list page shows. Opening a list takes a snapshot on the server
 * (the response names it in `as_of`); every later page and poll of that
 * snapshot sends the token back, so arrivals never shift its pages. A new
 * `snapshot` id always starts from a fresh request, never from a cached one.
 */
export interface SnapshotPosition {
  readonly snapshot: number;
  /** The token of the snapshot's first response; `null` until it arrives. */
  readonly asOf: string | null;
  readonly page: number;
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: getSession,
  staleTime: 0,
});

export const overviewQuery = queryOptions({
  queryKey: ['overview'],
  queryFn: getOverview,
});

/** The running build cannot change without a process restart, so one fetch is enough. */
export const versionQuery = queryOptions({
  queryKey: ['version'],
  queryFn: getVersion,
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * The dashboard slice: standing warnings plus the latest five unread events.
 * The background refetch is suspended by TanStack Query while the tab is
 * hidden; pages also refetch explicitly when they become visible again.
 */
export const warningsSummaryQuery = queryOptions({
  queryKey: ['warnings', 'summary'],
  queryFn: () => listWarnings({ limit: 5, unread: true }),
  refetchInterval: 10_000,
});

/**
 * The connection state lives in the running process, so a page that stays open
 * has to poll for transitions; the settings page also invalidates it after a
 * write. File-derived fields (`revision`, `token_configured`) follow the same
 * cadence, which is enough for a panel.
 */
export const telegramQuery = queryOptions({
  queryKey: ['telegram'],
  queryFn: getTelegram,
  refetchInterval: 10_000,
});

export function warningsQuery(position: SnapshotPosition) {
  return queryOptions({
    queryKey: ['warnings', 'list', position.snapshot, position.page],
    queryFn: () => listWarnings({ limit: PAGE_SIZE, ...snapshotWindow(position) }),
    placeholderData: withinSnapshot(position.snapshot),
    refetchInterval: LIST_POLL_MS,
  });
}

export function usageQuery(days: number) {
  return queryOptions({
    queryKey: ['usage', days],
    queryFn: () => getUsage(days),
  });
}

export const stickerSetsQuery = queryOptions({
  queryKey: ['sticker-sets'],
  queryFn: listStickerSets,
});

/**
 * Keeps the previous page on screen only while moving inside one snapshot.
 * New filters or a new snapshot show the loading state instead: rows read
 * under other conditions must not pass for the answer being fetched.
 */
function withinSnapshot<T>(snapshot: number) {
  return (previous: T | undefined, previousQuery: Query<T, Error, T, readonly unknown[]> | undefined): T | undefined =>
    previousQuery?.queryKey[2] === snapshot ? previous : undefined;
}

/** The page's window inside its snapshot; no `as_of` asks for a new snapshot. */
function snapshotWindow(position: SnapshotPosition): { readonly offset: number; readonly as_of?: string } {
  return {
    offset: (position.page - 1) * PAGE_SIZE,
    ...(position.asOf === null ? {} : { as_of: position.asOf }),
  };
}

/**
 * One page of a snapshot listing. The key names the snapshot by its id rather
 * than by `as_of`: the token only exists after the snapshot's first response,
 * and pinning it must not turn that response into a second request. Polling
 * refreshes the page's rows and `new_count` without leaving the snapshot.
 */
function snapshotList<T>(
  key: string,
  list: (filters: ListFilters) => Promise<Page<T>>,
  filters: ListFilters,
  position: SnapshotPosition,
) {
  return queryOptions({
    queryKey: [key, filters, position.snapshot, position.page],
    queryFn: () => list({ ...filters, limit: PAGE_SIZE, ...snapshotWindow(position) }),
    placeholderData: withinSnapshot(position.snapshot),
    refetchInterval: LIST_POLL_MS,
  });
}

export function invocationsQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('invocations', listInvocations, filters, position);
}

export function messagesQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('messages', listMessages, filters, position);
}

export function stickersQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('stickers', listStickers, filters, position);
}

export function memoriesQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('memories', listMemories, filters, position);
}

export function groupMemoriesQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('group-memories', listGroupMemories, filters, position);
}

export function alarmsQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('alarms', listAlarms, filters, position);
}

export function conversationContextsQuery(filters: ListFilters, position: SnapshotPosition) {
  return snapshotList('contexts', listConversationContexts, filters, position);
}

export function conversationContextQuery(conversationId: string) {
  return queryOptions({
    queryKey: ['context', conversationId],
    queryFn: () => getConversationContext(conversationId),
  });
}

export const memoryChatsQuery = queryOptions({
  queryKey: ['memory-chats'],
  queryFn: listMemoryChats,
});

export const apiKeysQuery = queryOptions({
  queryKey: ['api-keys'],
  queryFn: listApiKeys,
  staleTime: 0,
});

export const passkeysQuery = queryOptions({
  queryKey: ['passkeys'],
  queryFn: listPasskeys,
  staleTime: 0,
});

export const adminsQuery = queryOptions({
  queryKey: ['admins'],
  queryFn: listBotAdmins,
});

export const chatsQuery = queryOptions({
  queryKey: ['chats'],
  queryFn: getChats,
  staleTime: 0,
});

export const providersQuery = queryOptions({
  queryKey: ['providers'],
  queryFn: getProviders,
  // The page writes and reads the same resource, so a cached view goes stale on
  // every write; the mutations invalidate it explicitly.
  staleTime: 0,
});

export const providerPresetsQuery = queryOptions({
  queryKey: ['provider-presets'],
  queryFn: getProviderPresets,
});

export const configStatusQuery = queryOptions({
  queryKey: ['config-status'],
  queryFn: getConfigStatus,
});

export const developerQuery = queryOptions({
  queryKey: ['developer'],
  queryFn: getDeveloperSettings,
  staleTime: 0,
});

export const harnessQuery = queryOptions({
  queryKey: ['harness'],
  queryFn: getHarnessSettings,
  staleTime: 0,
});

/**
 * Prompt reads and writes share one resource, so the page invalidates both
 * queries after a write: the file view drives the editor, the versions view
 * drives history and the applied-version status.
 */
export function promptDocumentQuery(reference: PromptScopeRef) {
  return queryOptions({
    queryKey: ['prompt-document', reference.scope, reference.scope === 'group' ? reference.chat : null],
    queryFn: () => getPromptDocument(reference),
    staleTime: 0,
  });
}

export function promptVersionsQuery(reference: PromptScopeRef) {
  return queryOptions({
    queryKey: ['prompt-versions', reference.scope, reference.scope === 'group' ? reference.chat : null],
    queryFn: () => getPromptVersions(reference),
    staleTime: 0,
  });
}

export function promptDiffQuery(from: string, to: string) {
  return queryOptions({
    queryKey: ['prompt-diff', from, to],
    queryFn: () => getPromptDiff(from, to),
    retry: false,
  });
}

export function invocationQuery(id: string) {
  return queryOptions({
    queryKey: ['invocation', id],
    queryFn: () => getInvocation(id),
  });
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

/** `global` scope has no chat; a group scope always names its Telegram chat ID. */
export interface DictionaryQueryScope {
  readonly scope: DictionaryScope;
  readonly chat: string | null;
}

/**
 * The dictionary list is a whole-scope read (entries + conflicts), not a
 * snapshot page: conflicts are computed over the entire effective
 * dictionary, so pagination would make them meaningless.
 */
export function dictionaryQuery(target: DictionaryQueryScope, search: string) {
  return queryOptions({
    queryKey: ['dictionary', target.scope, target.chat, search],
    queryFn: () => listDictionary({ scope: target.scope, chat: target.chat, search }),
    placeholderData: (previous) => previous,
  });
}

export function dictionarySettingsQuery(chat: string | null) {
  return queryOptions({
    queryKey: ['dictionary-settings', chat],
    queryFn: () => getDictionarySettings(chat),
    staleTime: 0,
  });
}

export const dictionaryChatsQuery = queryOptions({
  queryKey: ['dictionary-chats'],
  queryFn: listDictionaryChats,
});

export function messageQuery(id: string) {
  return queryOptions({
    queryKey: ['message', id],
    queryFn: () => getMessage(id),
  });
}

// ---------------------------------------------------------------------------
// Playground rooms
// ---------------------------------------------------------------------------

export const playgroundRoomsQuery = queryOptions({
  queryKey: ['playground-rooms'],
  queryFn: listPlaygroundRooms,
});

export function playgroundRoomQuery(roomId: string) {
  return queryOptions({
    queryKey: ['playground-room', roomId],
    queryFn: () => getPlaygroundRoom(roomId),
    enabled: roomId.length > 0,
    // The status half of the page polls here; messages have their own query.
    refetchInterval: 2_000,
  });
}

export function playgroundMessagesQuery(roomId: string) {
  return infiniteQueryOptions({
    queryKey: ['playground-messages', roomId],
    queryFn: ({ pageParam }) =>
      listPlaygroundMessages(roomId, {
        ...(pageParam === undefined ? {} : { before: pageParam }),
        limit: PLAYGROUND_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.has_more ? (last.items.at(-1)?.seq ?? undefined) : undefined),
    enabled: roomId.length > 0,
    // Bot output lands after the Release that caused it, without touching
    // anything the page invalidates, so the timeline polls like the status.
    refetchInterval: 2_000,
  });
}

export function playgroundInvocationsQuery(roomId: string, limit: number, offset: number) {
  return queryOptions({
    queryKey: ['playground-invocations', roomId, limit, offset],
    queryFn: () => listPlaygroundInvocations(roomId, limit, offset),
    enabled: roomId.length > 0,
    refetchInterval: 2_000,
  });
}

export function playgroundReleaseQuery(roomId: string, releaseId: string) {
  return queryOptions({
    queryKey: ['playground-release', roomId, releaseId],
    queryFn: () => getPlaygroundRelease(roomId, releaseId),
    enabled: roomId.length > 0 && releaseId.length > 0,
    // An open Release follows its attempts until none of them can change.
    refetchInterval: (query) =>
      query.state.data?.attempts.some((attempt) => attempt.state === 'queued' || attempt.state === 'running') === true
        ? 2_000
        : false,
  });
}

/** Timeline pages of 50: a room's history is short and its polling is cheap. */
export const PLAYGROUND_PAGE_SIZE = 50;
