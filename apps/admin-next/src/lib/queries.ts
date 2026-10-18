import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  type DictionaryScope,
  getChats,
  getPlaygroundRelease,
  getPlaygroundRoom,
  getConfigStatus,
  getConversationContext,
  getDeveloperSettings,
  getHarnessSettings,
  getDictionarySettings,
  getInvocation,
  getMessage,
  getOverview,
  getPromptDiff,
  getPromptDocument,
  getPromptVersions,
  getProviderPresets,
  getProviders,
  getSession,
  getUsage,
  type ListFilters,
  listAlarms,
  listApiKeys,
  listBotAdmins,
  listConversationContexts,
  listDictionary,
  listDictionaryChats,
  listInvocations,
  listMemories,
  listMemoryChats,
  listPlaygroundInvocations,
  listPlaygroundMessages,
  listPlaygroundRooms,
  listMessages,
  listPasskeys,
  listStickerSets,
  listStickers,
  type Page,
  type PromptScopeRef,
} from './api.ts';

export const PAGE_SIZE = 25;

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: getSession,
  staleTime: 0,
});

export const overviewQuery = queryOptions({
  queryKey: ['overview'],
  queryFn: getOverview,
});

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

function infiniteList<T>(key: string, list: (filters: ListFilters) => Promise<Page<T>>, filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: [key, filters],
    queryFn: ({ pageParam }) => list({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function invocationsQuery(filters: ListFilters) {
  return infiniteList('invocations', listInvocations, filters);
}

export function messagesQuery(filters: ListFilters) {
  return infiniteList('messages', listMessages, filters);
}

export function stickersQuery(filters: ListFilters) {
  return infiniteList('stickers', listStickers, filters);
}

export function memoriesQuery(filters: ListFilters) {
  return infiniteList('memories', listMemories, filters);
}

export function alarmsQuery(filters: ListFilters) {
  return infiniteList('alarms', listAlarms, filters);
}

export function conversationContextsQuery(filters: ListFilters) {
  return infiniteList('contexts', listConversationContexts, filters);
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
 * keyset-cursor page: conflicts are computed over the entire effective
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
  });
}

export function playgroundInvocationsQuery(roomId: string) {
  return queryOptions({
    queryKey: ['playground-invocations', roomId],
    queryFn: () => listPlaygroundInvocations(roomId, 20),
    enabled: roomId.length > 0,
    refetchInterval: 2_000,
  });
}

export function playgroundReleaseQuery(roomId: string, releaseId: string) {
  return queryOptions({
    queryKey: ['playground-release', roomId, releaseId],
    queryFn: () => getPlaygroundRelease(roomId, releaseId),
    enabled: roomId.length > 0 && releaseId.length > 0,
  });
}

/** Timeline pages of 50: a room's history is short and its polling is cheap. */
export const PLAYGROUND_PAGE_SIZE = 50;
