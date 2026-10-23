import { call, writeHeaders } from './core.ts';

export interface BotAdminEntry {
  readonly telegram_user_id: string;
}

export interface AdminDraft {
  readonly telegram_user_id: number;
}

export interface BotAdminList {
  readonly items: readonly BotAdminEntry[];
  /** SHA-256 of config.jsonc; writes have to echo it via `If-Match`. */
  readonly revision: string;
}

export interface AdminApiKeyItem {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface AdminApiKeyList {
  readonly items: readonly AdminApiKeyItem[];
}

export interface CreatedAdminApiKey {
  readonly key: string;
  readonly item: AdminApiKeyItem;
}

export function listApiKeys(): Promise<AdminApiKeyList> {
  return call<AdminApiKeyList>('/api-keys');
}

export function createApiKey(name: string): Promise<CreatedAdminApiKey> {
  return call<CreatedAdminApiKey>('/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function revokeApiKey(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listBotAdmins(): Promise<BotAdminList> {
  return call<BotAdminList>('/admins');
}

export function addBotAdmin(draft: AdminDraft, revision: string): Promise<BotAdminList> {
  return call<BotAdminList>('/admins', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(draft),
  });
}

export function removeBotAdmin(telegramUserId: string, revision: string): Promise<BotAdminList> {
  return call<BotAdminList>(`/admins/${encodeURIComponent(telegramUserId)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}
