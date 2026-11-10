import { useSyncExternalStore } from 'react';

interface MediaQueryStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly matches: () => boolean;
}

// One store per query: useSyncExternalStore resubscribes whenever `subscribe` changes identity, so both the
// MediaQueryList and the functions reading it are created once and reused by every render.
const stores = new Map<string, MediaQueryStore>();
function store(query: string): MediaQueryStore {
  let entry = stores.get(query);
  if (!entry) {
    const mql = window.matchMedia(query);
    entry = {
      subscribe: (onChange) => {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      },
      matches: () => mql.matches,
    };
    stores.set(query, entry);
  }
  return entry;
}

/**
 * A CSS media query as a boolean, for the few places where the DOM has to change shape rather than just style:
 * a collapsed sidebar shows its branches in a flyout, but the mobile drawer is always full width and expands
 * them in place.
 */
export function useMediaQuery(query: string) {
  const { subscribe, matches } = store(query);
  return useSyncExternalStore(subscribe, matches);
}
