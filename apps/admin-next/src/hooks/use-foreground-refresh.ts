import { useEffect } from 'react';

/**
 * Refetches once whenever the tab returns to the foreground. Polling itself is
 * paused in the background by TanStack Query, so this is what makes the first
 * view after a return current instead of waiting out a 10-second interval.
 */
export function useForegroundRefresh(refetch: () => void): void {
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refetch]);
}
