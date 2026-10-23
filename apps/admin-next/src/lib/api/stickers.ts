import { call, type ListFilters, listPath, type Page } from './core.ts';

export interface StickerSetEntry {
  readonly id: string;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
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

export function listStickerSets(): Promise<{ items: readonly StickerSetEntry[] }> {
  return call<{ items: readonly StickerSetEntry[] }>('/sticker-sets');
}

export function listStickers(filters: ListFilters): Promise<Page<StickerEntry>> {
  return call<Page<StickerEntry>>(listPath('/stickers', filters));
}
