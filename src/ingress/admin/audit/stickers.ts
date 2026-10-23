import { type SQL, sql } from 'drizzle-orm';
import type { Orm } from '../../../store/store.ts';
import {
  AdminQueryError,
  appendCursor,
  assertToken,
  bit,
  escapeLike,
  type ListQuery,
  MAX_SEARCH_LENGTH,
  num,
  type Page,
  page,
  parseLimit,
  whereSql,
} from '../audit.ts';

interface StickerSetRow {
  readonly id: bigint;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  readonly configured: bigint;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: bigint;
  readonly indexed_count: bigint;
  readonly pending_count: bigint;
  readonly error_count: bigint;
}

interface StickerRow {
  readonly id: bigint;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: bigint;
  readonly index_state: string;
  readonly failure_count: bigint;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis_id: bigint | null;
  readonly analysis_state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: bigint | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly analysis_updated_at: string | null;
}

export function listStickerSets(orm: Orm): readonly Record<string, unknown>[] {
  const rows =
    orm.all<StickerSetRow>(sql`SELECT ss.id, ss.alias, ss.telegram_name, ss.title, ss.configured, ss.sync_state, ss.last_synced_at,
              ss.error_code, ss.updated_at,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1) AS sticker_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'success') AS indexed_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state IN ('pending', 'running')) AS pending_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'error') AS error_count
       FROM sticker_sets ss
       ORDER BY ss.configured DESC, ss.alias`);
  return rows.map((row) => ({
    id: row.id.toString(),
    alias: row.alias,
    telegram_name: row.telegram_name,
    title: row.title,
    configured: bit(row.configured),
    sync_state: row.sync_state,
    last_synced_at: row.last_synced_at,
    error_code: row.error_code,
    updated_at: row.updated_at,
    sticker_count: Number(row.sticker_count),
    indexed_count: Number(row.indexed_count),
    pending_count: Number(row.pending_count),
    error_count: Number(row.error_count),
  }));
}

export function listStickers(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  appendCursor(conditions, sql`s.id`, query.cursor);
  if (query.set !== undefined && query.set !== null && query.set.length > 0) {
    conditions.push(sql`ss.alias = ${assertToken(query.set, 'set')}`);
  }
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push(sql`s.index_state = ${assertToken(query.state, 'state')}`);
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) {
      throw new AdminQueryError('invalid_search', 'Search text is too long');
    }
    const like = escapeLike(query.search);
    conditions.push(sql`(ma.description LIKE ${like} ESCAPE '\\' OR s.emoji LIKE ${like} ESCAPE '\\')`);
  }
  const rows =
    orm.all<StickerRow>(sql`SELECT s.id, ss.alias AS set_alias, s.file_unique_id, s.emoji, s.format, s.active, s.index_state,
              s.failure_count, s.next_retry_at, s.updated_at,
              ma.id AS analysis_id, ma.state AS analysis_state, ma.analysis_version, ma.provider, ma.model,
              ma.prompt_version, ma.description, ma.metadata_json, ma.updated_at AS analysis_updated_at
       FROM stickers s
       JOIN sticker_sets ss ON ss.id = s.sticker_set_id
       LEFT JOIN media_analyses ma ON ma.id = s.current_analysis_id
       ${whereSql(conditions)}
       ORDER BY s.id DESC
       LIMIT ${BigInt(limit + 1)}`);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    set_alias: row.set_alias,
    file_unique_id: row.file_unique_id,
    emoji: row.emoji,
    format: row.format,
    active: bit(row.active),
    index_state: row.index_state,
    failure_count: Number(row.failure_count),
    next_retry_at: row.next_retry_at,
    updated_at: row.updated_at,
    analysis:
      row.analysis_id === null
        ? null
        : {
            id: row.analysis_id.toString(),
            state: row.analysis_state,
            analysis_version: row.analysis_version,
            provider: row.provider,
            model: row.model,
            prompt_version: num(row.prompt_version),
            description: row.description,
            metadata_json: row.metadata_json,
            updated_at: row.analysis_updated_at,
          },
  }));
}
