/**
 * Database side of stopping a Telegram instance.
 *
 * Stopping a Telegram connection is not a transport detail: work already
 * accepted for Telegram conversations must not survive it. Queued and
 * collecting batches expire, queued invocations abort, and any long-task
 * receipt they claimed returns to `pending` so the delivery happens once the
 * instance is back. Only Telegram conversations are touched; rooms keep their
 * queue exactly as it is.
 */

import { sql } from 'drizzle-orm';
import { asRunResult, type BusinessStore } from '../../store/store.ts';

/** The one reason code an instance stop writes. */
export const TELEGRAM_STOPPED_REASON = 'telegram_stopped';

/** A SQL predicate naming every conversation of the Telegram host. */
const TELEGRAM_CONVERSATIONS = sql`(
  SELECT v.id FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE c.host_kind = 'telegram'
)`;

export interface AbandonedTelegramWork {
  readonly expiredBuckets: number;
  readonly abortedInvocations: number;
  /** Invocations still running when the work was abandoned; the caller aborts them. */
  readonly runningInvocationIds: readonly bigint[];
}

/**
 * One transaction that closes everything Telegram has not started, so an
 * instance stop cannot leave a fresh invocation behind.
 *
 * A batch attached to a running invocation but not yet injected would be
 * re-queued when that run releases it; expiring it first makes the release a
 * no-op, and the receipt reset below is what returns its delivery to `pending`.
 * Receipts of queued invocations are reset before their invocations abort,
 * because `claimed` is the link between them.
 */
export function abandonTelegramWork(store: BusinessStore, now = new Date()): AbandonedTelegramWork {
  const timestamp = now.toISOString();
  return store.transaction(() => {
    const running = store.orm
      .all<{ id: bigint }>(
        sql`SELECT i.id FROM invocations i
          JOIN conversations v ON v.id = i.conversation_id
          JOIN chats c ON c.id = v.chat_id
          WHERE i.state = 'running' AND c.host_kind = 'telegram'
          ORDER BY i.id`,
      )
      .map((row) => row.id);

    const expiredBuckets = asRunResult(
      store.orm.run(sql`UPDATE buckets
        SET state = 'expired', error_code = ${TELEGRAM_STOPPED_REASON},
            finished_at = ${timestamp}, updated_at = ${timestamp}
        WHERE conversation_id IN ${TELEGRAM_CONVERSATIONS}
          AND (
            state IN ('collecting', 'queued')
            OR (
              state = 'running' AND id IN (
                SELECT ib.bucket_id FROM invocation_buckets ib
                JOIN invocations i ON i.id = ib.invocation_id
                WHERE i.state = 'running' AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
              )
            )
          )`),
    ).changes;

    // The delivery itself was never attempted, so the receipt goes back to the
    // queue instead of being cancelled like an admin stop would cancel it.
    store.orm.run(sql`UPDATE task_receipts
      SET state = 'pending', invocation_id = NULL, bucket_id = NULL, claimed_at = NULL,
          handled_at = NULL, invocation_outcome = NULL, completion_reason = NULL,
          cancelled_at = NULL, cancelled_by = NULL, admin_cancelled = 0, cancel_reason = NULL,
          updated_at = ${timestamp}
      WHERE state = 'claimed' AND invocation_id IN (
        SELECT i.id FROM invocations i
        JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id
        WHERE i.state = 'queued' AND c.host_kind = 'telegram'
      )`);

    const abortedInvocations = asRunResult(
      store.orm.run(sql`UPDATE invocations
        SET state = 'aborted', completion_reason = ${TELEGRAM_STOPPED_REASON}, finished_at = ${timestamp}
        WHERE state = 'queued' AND conversation_id IN ${TELEGRAM_CONVERSATIONS}`),
    ).changes;

    return { expiredBuckets, abortedInvocations, runningInvocationIds: running };
  });
}

/**
 * Waits until the aborted runs have persisted their own terminal state. The
 * budget is a courtesy to the restart path, not a correctness requirement:
 * whatever is still running is reported and the caller carries on.
 */
export async function waitForTelegramInvocations(
  store: BusinessStore,
  ids: readonly bigint[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  pollIntervalMs = 25,
): Promise<readonly bigint[]> {
  if (ids.length === 0) {
    return [];
  }
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const remaining = (): readonly bigint[] =>
    store.orm
      .all<{ id: bigint }>(sql`SELECT id FROM invocations WHERE state = 'running' AND id IN (${list}) ORDER BY id`)
      .map((row) => row.id);
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    const running = remaining();
    if (running.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return remaining();
}

/**
 * Returns receipts claimed by interrupted invocations to `pending` and marks
 * the batches those runs opened with the stop reason.
 *
 * An aborted run persists its receipts as `handled` (and releases any
 * un-injected batch as `suppressed`); both mean "this delivery did not happen
 * because Telegram stopped", which is exactly what a re-delivery must undo.
 */
export function restoreAbandonedReceipts(store: BusinessStore, ids: readonly bigint[], now = new Date()): void {
  if (ids.length === 0) {
    return;
  }
  const timestamp = now.toISOString();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  store.transaction(() => {
    store.orm.run(sql`UPDATE task_receipts
      SET state = 'pending', invocation_id = NULL, bucket_id = NULL, claimed_at = NULL,
          handled_at = NULL, invocation_outcome = NULL, completion_reason = NULL,
          cancelled_at = NULL, cancelled_by = NULL, admin_cancelled = 0, cancel_reason = NULL,
          updated_at = ${timestamp}
      WHERE invocation_id IN (${list}) AND state IN ('claimed', 'handled', 'suppressed')`);
    // The abort itself closes the opening batch without a reason; the stop is
    // what ended it, so record that instead of leaving the cause empty.
    store.orm.run(sql`UPDATE buckets
      SET error_code = ${TELEGRAM_STOPPED_REASON}, updated_at = ${timestamp}
      WHERE error_code IS NULL AND state IN ('aborted', 'expired')
        AND id IN (
          SELECT bucket_id FROM invocations WHERE id IN (${list})
          UNION
          SELECT bucket_id FROM invocation_buckets WHERE invocation_id IN (${list})
        )`);
  });
}
