import { useRef, useState } from 'react';

/**
 * Numbers the sessions of a dialog that stays mounted across opens.
 *
 * Async work started in one session (a request, a file read, a clipboard
 * write) keeps running after the dialog closes, and nothing cancels its
 * callbacks. Each piece of work captures `current` when it starts and drops
 * its result if the number has moved on, so it can neither act on a closed
 * dialog nor write into the session opened after it.
 *
 * The number moves on both edges of `open`. It only ever counts up, so a
 * repeated or abandoned render can at worst retire work nobody waits for.
 */
export function useOpenSession(open: boolean): { readonly current: number } {
  const session = useRef(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    session.current += 1;
  }
  return session;
}
