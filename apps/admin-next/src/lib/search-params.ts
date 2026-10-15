import { useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';

/**
 * URL-managed chat scope shared by the list pages. Telegram chat IDs are kept
 * as strings end to end; the validator drops anything that is not a decimal
 * signed 64-bit integer shape so stale or hand-edited URLs degrade to "no
 * filter" instead of feeding garbage into queries.
 */

const CHAT_ID_PATTERN = /^-?\d{1,19}$/;

export interface ChatScopeSearch {
  chat?: string;
}

/** `validateSearch` for routes whose only URL-managed condition is `chat`. */
export function chatSearch(search: Record<string, unknown>): ChatScopeSearch {
  const raw = search.chat;
  if (typeof raw === 'string' && CHAT_ID_PATTERN.test(raw)) {
    return { chat: raw };
  }
  return {};
}

/** Reads the chat scope from the current location without per-route typing. */
export function useChatScope(): string | undefined {
  const search = useSearch({ strict: false }) as { readonly chat?: unknown };
  return typeof search.chat === 'string' && CHAT_ID_PATTERN.test(search.chat) ? search.chat : undefined;
}

/**
 * Minimal structural view of a route-typed navigate result. Pages create it
 * with `useNavigate({ from: '<route id>' })` so TanStack can type the search
 * reducer against that route's `validateSearch` output.
 */
export type ChatScopeNavigate = (opts: {
  readonly search: (prev: ChatScopeSearch) => ChatScopeSearch;
  readonly replace: true;
}) => Promise<unknown>;

/** Reducer producing the next search object for a chat scope change. */
export function chatScopeSearch(chat: string | undefined): (prev: ChatScopeSearch) => ChatScopeSearch {
  return (prev) => {
    const next = { ...prev };
    if (chat === undefined) {
      delete next.chat;
    } else {
      next.chat = chat;
    }
    return next;
  };
}

/** Applies a chat scope to the current route, replacing the history entry. */
export function useChatScopeSetter(navigate: ChatScopeNavigate): (chat: string | undefined) => void {
  return useCallback(
    (chat: string | undefined) => {
      void navigate({ search: chatScopeSearch(chat), replace: true });
    },
    [navigate],
  );
}
