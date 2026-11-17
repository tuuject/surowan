import { call, postJson } from './core.ts';

/**
 * Where a configured secret comes from, as a panel session sees it. Values
 * never travel back; only the origin does.
 */
export type SecretSource =
  | { readonly kind: 'entry'; readonly name: string }
  | { readonly kind: 'env'; readonly env: string }
  | { readonly kind: 'command' }
  | null;

/** The body a secret-accepting write takes; mirrors the server's `SecretInput`. */
export type SecretInput = string | { readonly value: string; readonly name?: string } | { readonly entry: string };

export interface KeychainEntryView {
  readonly name: string;
  readonly created_at: string;
}

export interface ExternalRefView {
  readonly path: string;
  readonly kind: 'env' | 'command';
  readonly env?: string;
}

export interface KeychainUsageView {
  /** Entry name → config paths; `null` when the file could not be parsed. */
  readonly file: Readonly<Record<string, readonly string[]>> | null;
  readonly active: readonly string[];
  readonly external: readonly ExternalRefView[];
}

export interface KeychainSnapshotView {
  readonly entries: readonly KeychainEntryView[];
  readonly usage: KeychainUsageView;
}

export interface KeychainRotateResponse {
  readonly status: 'rotated';
  readonly name: string;
  readonly apply: { readonly applied: readonly string[]; readonly restart_required: readonly string[] };
}

export interface KeychainPurgeResponse {
  readonly deleted: readonly string[];
  readonly skipped: readonly string[];
}

export function getKeychain(): Promise<KeychainSnapshotView> {
  return call<KeychainSnapshotView>('/keychain');
}

export function createKeychainEntry(name: string, value: string): Promise<{ readonly status: string }> {
  return postJson('/keychain', { name, value });
}

export function rotateKeychainEntry(name: string, value: string): Promise<KeychainRotateResponse> {
  return call<KeychainRotateResponse>(`/keychain/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

export function deleteKeychainEntry(name: string): Promise<{ readonly status: string }> {
  return call<{ readonly status: string }>(`/keychain/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** The server deletes only those of `names` that are still orphans. */
export function purgeKeychain(names: readonly string[]): Promise<KeychainPurgeResponse> {
  return postJson<KeychainPurgeResponse>('/keychain/purge', { names });
}
