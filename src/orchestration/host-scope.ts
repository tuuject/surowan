/**
 * Host scoping shared by the Scheduler and the invocation queue.
 *
 * A process's static host scope says which hosts it assembled; live readiness
 * says which of them can act right now (a Telegram instance that is disabled,
 * misconfigured or still connecting may not). Every pass narrows the first by
 * the second, so a host that is not ready keeps its work exactly where it is
 * instead of launching, failing or delivering it.
 */

import { type SQL, sql } from 'drizzle-orm';
import { HOST_KINDS, type HostKind } from '../platform/im-host.ts';

/** Whether one host may execute work at this moment. */
export type HostReadiness = (host: HostKind) => boolean;

/** A scope with no connection gating: every host of the process is ready. */
export const everyHostReady: HostReadiness = () => true;

/** The hosts a pass may touch now: the process scope narrowed by live readiness. */
export function activeHosts(hosts: readonly HostKind[] | undefined, isHostReady: HostReadiness): readonly HostKind[] {
  const scope = hosts === undefined || hosts.length === 0 ? HOST_KINDS : hosts;
  return scope.filter((host) => isHostReady(host));
}

/**
 * `column` names a conversation id of one of `hosts`; always true when every
 * known host is active, and never true when none is.
 */
export function conversationsOfHosts(hosts: readonly HostKind[], column: SQL): SQL {
  if (hosts.length === 0) {
    return sql`1 = 0`;
  }
  if (hosts.length === HOST_KINDS.length) {
    return sql`1 = 1`;
  }
  return sql`${column} IN (SELECT v.id FROM conversations v JOIN chats c ON c.id = v.chat_id
      WHERE c.host_kind IN (${sql.join(
        hosts.map((host) => sql`${host}`),
        sql`, `,
      )}))`;
}
