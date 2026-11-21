/**
 * Refetches for a change-driven page.
 *
 * A live page is told about a change at most once a second, and its fetch can
 * take longer than that (a large Invocation with its recorded model payloads,
 * over a slow link). `refetch()` cancels the in-flight request by default, so
 * naively calling it per event would restart the fetch before it can ever
 * deliver a result. This coalescer instead lets the running request finish and
 * remembers that another one is owed: exactly one trailing refetch follows,
 * which is what picks up whatever was written while the first one was on the
 * wire.
 */

export interface CoalescedRefresh {
  /** Runs `run` now, or schedules exactly one trailing run if one is in flight. */
  readonly schedule: () => void;
}

export function createCoalescedRefresh(run: () => Promise<unknown>): CoalescedRefresh {
  let inFlight = false;
  let queued = false;

  const start = (): void => {
    inFlight = true;
    void run()
      // The page owns its error state (a failed background refetch must not
      // become an unhandled rejection); only the scheduling matters here.
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          start();
        }
      });
  };

  return {
    schedule: () => {
      if (inFlight) {
        queued = true;
        return;
      }
      start();
    },
  };
}
