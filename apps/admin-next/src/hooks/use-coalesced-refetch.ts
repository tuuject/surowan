import { useEffectEvent, useRef } from 'react';
import { type CoalescedRefresh, createCoalescedRefresh } from '@/lib/coalesced-refresh.ts';

/**
 * The change handler both live Invocation views hand to `useLiveRefresh`.
 *
 * The returned function is stable across renders, always calls the latest
 * `refetch`, and never cancels an in-flight fetch: the coalescer lets it finish
 * and runs one trailing refetch for whatever changed meanwhile. That is the
 * difference between a busy run refreshing once a second and a busy run whose
 * fetches are aborted before they can land.
 */
export function useCoalescedRefetch(refetch: () => Promise<unknown>): () => void {
  const latest = useEffectEvent(refetch);
  const scheduler = useRef<CoalescedRefresh | null>(null);
  scheduler.current ??= createCoalescedRefresh(() => latest());
  return scheduler.current.schedule;
}
