import { resolve } from 'node:path';

/** Repository root, resolved from this module under scripts/audit/. */
export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const DEFAULT_DATABASE = resolve(REPO_ROOT, 'dev-data/data/plasticwan.sqlite');
export const DEFAULT_LIMIT = 15;

const PREVIEW_CHARACTERS = 200;

export function preview(value: string | null, max = PREVIEW_CHARACTERS): string {
  if (value === null) {
    return '';
  }
  const collapsed = value.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export function field(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return '';
}

export interface SnapshotMessage {
  readonly message_id?: unknown;
  readonly telegram_date?: unknown;
  readonly sent_by_bot?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly caption?: unknown;
  readonly sender?: { readonly name?: unknown; readonly username?: unknown } | undefined;
  readonly media?: readonly unknown[] | undefined;
}

export function parseSnapshot(json: string): SnapshotMessage | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as SnapshotMessage) : null;
  } catch {
    return null;
  }
}
