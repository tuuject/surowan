import { call, type ListFilters, listPath, type Page, writeHeaders } from './core.ts';
import type { ModelApplySummary } from './models.ts';

export interface StickerSetEntry {
  readonly id: string;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  /** Operator guidance on when to use the set; the model sees it with the catalog. */
  readonly note: string | null;
  /** False for a removed set whose row and index are kept for a re-add. */
  readonly configured: boolean;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: number;
  readonly indexed_count: number;
  readonly pending_count: number;
  readonly error_count: number;
}

export interface StickerSetList {
  readonly items: readonly StickerSetEntry[];
  /** `config.jsonc` revision for writes; `null` when the file cannot be read. */
  readonly revision: string | null;
}

export interface StickerSetWriteResult extends StickerSetList {
  readonly apply: ModelApplySummary;
}

export interface StickerSetDraft {
  /** A Telegram set name or its t.me/addstickers link. */
  readonly name: string;
  readonly alias: string;
  readonly note: string | null;
}

export interface StickerSetUpdate {
  readonly alias: string;
  readonly note: string | null;
}

export interface StickerAnalysis {
  readonly id: string;
  readonly state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: number | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly updated_at: string | null;
}

export interface StickerEntry {
  readonly id: string;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: boolean;
  readonly index_state: string;
  readonly failure_count: number;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis: StickerAnalysis | null;
}

export function listStickerSets(): Promise<StickerSetList> {
  return call<StickerSetList>('/sticker-sets');
}

export function addStickerSet(draft: StickerSetDraft, revision: string): Promise<StickerSetWriteResult> {
  return call<StickerSetWriteResult>('/sticker-sets', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(draft),
  });
}

export function updateStickerSet(
  alias: string,
  update: StickerSetUpdate,
  revision: string,
): Promise<StickerSetWriteResult> {
  return call<StickerSetWriteResult>(`/sticker-sets/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(update),
  });
}

export function removeStickerSet(alias: string, revision: string): Promise<StickerSetWriteResult> {
  return call<StickerSetWriteResult>(`/sticker-sets/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export function listStickers(filters: ListFilters): Promise<Page<StickerEntry>> {
  return call<Page<StickerEntry>>(listPath('/stickers', filters));
}
