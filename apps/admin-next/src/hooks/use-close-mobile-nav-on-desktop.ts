import { useEffect } from 'react';
import { useUiStore } from '@/stores/ui';

/**
 * The mobile drawer only exists below md. Closing it when the viewport reaches desktop keeps the store from
 * staying "open" behind the breakpoint, so resizing back down doesn't reopen a drawer the user never asked for.
 */
export function useCloseMobileNavOnDesktop(desktop: boolean) {
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);
  useEffect(() => {
    if (desktop) {
      setMobileNavOpen(false);
    }
  }, [desktop, setMobileNavOpen]);
}
