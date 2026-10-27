import { sql } from 'drizzle-orm';
import type { Orm } from '../../../store/store.ts';

/**
 * Stops every running invocation when web search stops being available.
 *
 * Turning the switch off, or disabling the last enabled engine, removes the
 * search capability and its skill from the index. An invocation already running
 * was assembled with the old set and must not keep answering from it: the next
 * message starts in a rebuilt context. Both the switch and an empty enabled set
 * arrive here as `available === false`, because they have the same effect.
 */
export function abortRunningInvocationsOnSearchDisable(
  orm: Pick<Orm, 'all'>,
  abort: (ids: readonly bigint[], reason: string) => number,
): number {
  const running = orm.all<{ id: bigint }>(sql`SELECT id FROM invocations WHERE state = 'running'`);
  if (running.length === 0) {
    return 0;
  }
  return abort(
    running.map((row) => row.id),
    'web_search_disabled',
  );
}
