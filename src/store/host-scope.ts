import { eq, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { chats } from './schema/index.ts';

/**
 * Host scoping for readers of the shared Message/Context store.
 *
 * `chats`, `senders` and `messages` hold rows for more than one host, and the
 * Telegram identity columns are only populated on Telegram rows. A reader that
 * cannot do anything meaningful with a virtual row has two honest options, and
 * both are explicit: restrict the query with `telegramHostScope()`, or type the
 * identity as nullable and decide what the virtual case means.
 *
 * What is not allowed is reading a Telegram identity column and assuming it is
 * present, because that turns "the same database mixes hosts" into a crash in a
 * read-only surface.
 */
export function telegramHostScope(column: AnySQLiteColumn = chats.hostKind): SQL {
  return eq(column, 'telegram');
}

/**
 * Reads a Telegram identity column in a query that carries an explicit
 * `telegramHostScope()`. The predicate is what makes the column non-NULL, so the
 * invariant is asserted here with a message that names the column and the fix,
 * instead of a bare `!` that would silently ship a wrong identity if the
 * predicate were ever dropped.
 */
export function telegramIdentity<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`${column} is NULL: scope this reader with telegramHostScope() or type the identity as nullable`);
  }
  return value;
}
