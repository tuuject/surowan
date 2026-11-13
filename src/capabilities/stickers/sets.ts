import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import { stickerSets, stickers } from '../../store/schema/index.ts';

/** One `telegram.sticker_sets` entry: `name` is the identity, `alias` its nickname. */
export type ConfiguredStickerSet = NonNullable<RawConfig['telegram']['sticker_sets']>[number];

/**
 * Mirrors the configured sticker sets into the store, synchronously and without
 * Telegram: the panel and the catalog read the store, so a published change is
 * visible even while no bot is connected.
 *
 * A set is identified by its Telegram name, compared case-insensitively like
 * Telegram does; the alias and note are only copied. Renaming an alias
 * therefore keeps the row, its stickers and their index. A set that is new, or
 * configured again after a removal, is marked `pending` for the live worker to
 * fetch. A removed set keeps its row and its stickers' analyses, but its
 * stickers leave the catalog and the search index.
 */
export function reconcileStickerSets(
  store: BusinessStore,
  configured: readonly ConfiguredStickerSet[],
  now = new Date(),
): void {
  store.transaction(() => {
    const orm = store.orm;
    const timestamp = now.toISOString();
    const rows = orm
      .select({
        id: stickerSets.id,
        alias: stickerSets.alias,
        telegramName: stickerSets.telegramName,
        note: stickerSets.note,
        configured: stickerSets.configured,
      })
      .from(stickerSets)
      .orderBy(desc(stickerSets.configured), asc(stickerSets.id))
      .all();
    // Two stored spellings of one name can only come from older data; the
    // configured row, then the oldest, stands for the set.
    const byName = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = row.telegramName.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, row);
      }
    }
    // Every alias is released before any is assigned: a rename onto an alias
    // another configured set is giving up, or a swap, would otherwise collide
    // with the configured-alias unique index halfway through.
    orm.update(stickerSets).set({ configured: false }).where(eq(stickerSets.configured, true)).run();
    const kept = new Set<bigint>();
    for (const set of configured) {
      const note = set.note ?? null;
      const row = byName.get(set.name.toLowerCase());
      if (row === undefined) {
        orm
          .insert(stickerSets)
          .values({
            alias: set.alias,
            telegramName: set.name,
            note,
            configured: true,
            syncState: 'pending',
            updatedAt: timestamp,
          })
          .run();
        continue;
      }
      kept.add(row.id);
      const changed = !row.configured || row.alias !== set.alias || row.note !== note;
      orm
        .update(stickerSets)
        .set({
          alias: set.alias,
          note,
          configured: true,
          ...(row.configured ? {} : { syncState: 'pending', errorCode: null }),
          ...(changed ? { updatedAt: timestamp } : {}),
        })
        .where(eq(stickerSets.id, row.id))
        .run();
    }
    const removed = rows.filter((row) => row.configured && !kept.has(row.id)).map((row) => row.id);
    if (removed.length > 0) {
      orm.update(stickerSets).set({ updatedAt: timestamp }).where(inArray(stickerSets.id, removed)).run();
    }
    orm
      .update(stickers)
      .set({ active: false })
      .where(
        inArray(
          stickers.stickerSetId,
          orm.select({ id: stickerSets.id }).from(stickerSets).where(eq(stickerSets.configured, false)),
        ),
      )
      .run();
    orm.run(
      sql`DELETE FROM sticker_search WHERE sticker_id IN (SELECT CAST(s.id AS TEXT) FROM stickers s JOIN sticker_sets ss ON ss.id = s.sticker_set_id WHERE ss.configured = 0)`,
    );
  });
}
