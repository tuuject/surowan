import { useSyncExternalStore } from 'react';

// One MediaQueryList per query: useSyncExternalStore resubscribes whenever `subscribe` changes identity, and a
// fresh matchMedia per render would do that on every render.
const lists = new Map<string, MediaQueryList>();
function list(query: string) {
  let mql = lists.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    lists.set(query, mql);
  }
  return mql;
}

/**
 * A CSS media query as a boolean, for the few places where the DOM has to change shape rather than just style:
 * a collapsed sidebar shows its branches in a flyout, but the mobile drawer is always full width and expands
 * them in place.
 */
export function useMediaQuery(query: string) {
  const mql = list(query);
  return useSyncExternalStore(
    (onChange) => {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => mql.matches,
  );
}
