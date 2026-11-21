import { expect, test } from 'vitest';
import { createCoalescedRefresh } from './coalesced-refresh.ts';

/** A `run` whose calls the test resolves by hand, in order. */
function manualRun() {
  const calls: Array<{ readonly resolve: () => void; readonly reject: (error: Error) => void }> = [];
  const run = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      calls.push({ resolve: () => resolve(undefined), reject });
    });
  return { run, calls };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('an event during an in-flight refetch schedules exactly one trailing run', async () => {
  const { run, calls } = manualRun();
  const refresh = createCoalescedRefresh(run);

  refresh.schedule();
  expect(calls).toHaveLength(1);
  // The next events must not cancel the fetch that is already on the wire.
  refresh.schedule();
  refresh.schedule();
  refresh.schedule();
  expect(calls).toHaveLength(1);

  calls[0]?.resolve();
  await flush();
  // The trailing run picks up whatever was written during the first one.
  expect(calls).toHaveLength(2);

  calls[1]?.resolve();
  await flush();
  expect(calls).toHaveLength(2);
});

test('a settled refetch starts the next event immediately, and failures do not wedge it', async () => {
  const { run, calls } = manualRun();
  const refresh = createCoalescedRefresh(run);

  refresh.schedule();
  calls[0]?.reject(new Error('network'));
  await flush();
  refresh.schedule();
  expect(calls).toHaveLength(2);

  calls[1]?.resolve();
  await flush();
  refresh.schedule();
  expect(calls).toHaveLength(3);
});
