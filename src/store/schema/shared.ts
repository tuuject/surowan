import { customType } from 'drizzle-orm/sqlite-core';

/**
 * SQLite INTEGER column that maps to TypeScript `bigint`.
 *
 * drizzle's SQLite dialect has no built-in bigint mode, so this custom type
 * keeps the project invariant that SQLite row IDs and Telegram IDs are
 * `bigint` on both read and write. `better-sqlite3` accepts bigint bindings
 * natively; `fromDriver` also coerces plain numbers so the layer stays correct
 * regardless of the driver's safeIntegers setting.
 */
export const sqliteBigInt = customType<{ data: bigint; driverData: bigint | number }>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});

/**
 * `sqliteBigInt` for INTEGER PRIMARY KEY columns. SQLite assigns rowids to
 * these columns automatically, so inserts may omit the value; the `default`
 * marker teaches drizzle's insert types that the column is optional. It never
 * emits a DEFAULT clause at runtime.
 */
export const sqliteBigIntId = customType<{
  data: bigint;
  driverData: bigint | number;
  default: true;
}>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});
