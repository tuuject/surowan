import { expect, test } from 'vitest';
import { abortRunningInvocationsOnSearchDisable } from '../../src/adapters/local-monolith/runtime/web-search-availability.ts';
import type { Orm } from '../../src/store/store.ts';

test('disabling search stops every running invocation with its own reason', () => {
  const calls: { ids: readonly bigint[]; reason: string }[] = [];
  const stopped = abortRunningInvocationsOnSearchDisable(
    { all: () => [{ id: 1n }, { id: 7n }] } as unknown as Pick<Orm, 'all'>,
    (ids, reason) => {
      calls.push({ ids, reason });
      return ids.length;
    },
  );
  expect(stopped).toBe(2);
  expect(calls).toEqual([{ ids: [1n, 7n], reason: 'web_search_disabled' }]);
});

test('nothing is signalled when no invocation is running', () => {
  let called = false;
  const stopped = abortRunningInvocationsOnSearchDisable({ all: () => [] } as unknown as Pick<Orm, 'all'>, () => {
    called = true;
    return 0;
  });
  expect(stopped).toBe(0);
  expect(called).toBe(false);
});
