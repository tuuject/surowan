import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { asRunResult, type Orm } from '../../store/store.ts';
import { adminApiKeys } from '../../store/schema/index.ts';
import type { AdminAccess } from '@surowan/admin-surface';
import { AdminQueryError } from './audit/shared.ts';
import { hashToken } from './auth.ts';

/**
 * Programmatic Admin API keys.
 *
 * A key is `pwk_` plus 32 random bytes (256-bit) rendered as base64url. The
 * database stores only the SHA-256 digest, so the plaintext is recoverable
 * exactly once, from the create response. Keys are disabled permanently by
 * setting `revoked_at`; the row is kept so the panel can still show what was
 * issued and when it was last used.
 *
 * Permissions are three independent booleans internally. `read:all` is the
 * base grant and must be true for the key to authenticate; the other two are
 * optional. The panel and API expose only the four legal combinations.
 */
export const API_KEY_PREFIX = 'pwk_';
const API_KEY_BYTES = 32;
/** Display prefix length: `pwk_` plus the first 8 base64url characters. */
const PREFIX_DISPLAY_LENGTH = 12;
const MAX_NAME_LENGTH = 80;

export type ApiKeyMode = 'read' | 'read_write' | 'read_paid' | 'all';

export interface ApiKeyPermissions {
  readonly read_all: boolean;
  readonly write_all: boolean;
  readonly execute_paid_operations: boolean;
}

export interface AdminApiKeyItem {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  /** `null` when a database edit produced an illegal combination. */
  readonly mode: ApiKeyMode | null;
  readonly permissions: ApiKeyPermissions;
}

export interface CreatedAdminApiKey {
  /** Plaintext key; the only copy that will ever exist outside the caller. */
  readonly key: string;
  readonly item: AdminApiKeyItem;
}

export interface AuthenticatedApiKey {
  readonly id: bigint;
  readonly name: string;
  readonly permissions: ApiKeyPermissions;
  readonly mode: ApiKeyMode;
}

const API_KEY_FIELDS = {
  id: adminApiKeys.id,
  name: adminApiKeys.name,
  prefix: adminApiKeys.prefix,
  createdAt: adminApiKeys.createdAt,
  lastUsedAt: adminApiKeys.lastUsedAt,
  revokedAt: adminApiKeys.revokedAt,
  readAll: adminApiKeys.readAll,
  writeAll: adminApiKeys.writeAll,
  executePaidOperations: adminApiKeys.executePaidOperations,
} as const;

interface ApiKeyRow {
  readonly id: bigint;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly readAll: boolean;
  readonly writeAll: boolean;
  readonly executePaidOperations: boolean;
}

const modeValidator = Type.Union([
  Type.Literal('read'),
  Type.Literal('read_write'),
  Type.Literal('read_paid'),
  Type.Literal('all'),
]);

const createApiKeyBodyValidator = Compile(
  Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH }),
      mode: Type.Optional(modeValidator),
    },
    { additionalProperties: false },
  ),
);

const updateApiKeyBodyValidator = Compile(Type.Object({ mode: modeValidator }, { additionalProperties: false }));

export function permissionsFromMode(mode: ApiKeyMode): ApiKeyPermissions {
  return {
    read_all: true,
    write_all: mode === 'read_write' || mode === 'all',
    execute_paid_operations: mode === 'read_paid' || mode === 'all',
  };
}

/** `null` is the illegal combination a direct database edit can create. */
export function modeFromPermissions(permissions: ApiKeyPermissions): ApiKeyMode | null {
  if (!permissions.read_all) {
    return null;
  }
  if (permissions.write_all && permissions.execute_paid_operations) {
    return 'all';
  }
  if (permissions.write_all) {
    return 'read_write';
  }
  if (permissions.execute_paid_operations) {
    return 'read_paid';
  }
  return 'read';
}

/** The route's access requirement against a key's grants. */
export function accessAllowed(permissions: ApiKeyPermissions, access: AdminAccess): boolean {
  if (!permissions.read_all) {
    return false;
  }
  if (access === 'read') {
    return true;
  }
  if (access === 'write') {
    return permissions.write_all;
  }
  if (access === 'paid') {
    return permissions.execute_paid_operations;
  }
  return permissions.write_all && permissions.execute_paid_operations;
}

export function createApiKey(
  orm: Orm,
  name: string,
  mode: ApiKeyMode = 'read_paid',
  now = new Date(),
): CreatedAdminApiKey {
  const token = `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('base64url')}`;
  const permissions = permissionsFromMode(mode);
  const row = orm
    .insert(adminApiKeys)
    .values({
      name,
      prefix: token.slice(0, PREFIX_DISPLAY_LENGTH),
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      readAll: permissions.read_all,
      writeAll: permissions.write_all,
      executePaidOperations: permissions.execute_paid_operations,
    })
    .returning(API_KEY_FIELDS)
    .get();
  if (row === undefined) {
    throw new Error('admin_api_keys insert returned no row');
  }
  return { key: token, item: toItem(row) };
}

export function listApiKeys(orm: Orm): readonly AdminApiKeyItem[] {
  return orm.select(API_KEY_FIELDS).from(adminApiKeys).orderBy(desc(adminApiKeys.id)).all().map(toItem);
}

/** Revokes an active key; revoking twice is a not-found error, not a no-op. */
export function revokeApiKey(orm: Orm, id: bigint, now = new Date()): void {
  const result = asRunResult(
    orm
      .update(adminApiKeys)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(adminApiKeys.id, id), isNull(adminApiKeys.revokedAt)))
      .run(),
  );
  if (result.changes === 0) {
    throw new AdminQueryError('not_found', 'API key does not exist', 404);
  }
}

/** Replaces the grants; revoked keys keep their metadata and cannot be edited. */
export function updateApiKeyMode(orm: Orm, id: bigint, mode: ApiKeyMode): AdminApiKeyItem {
  const permissions = permissionsFromMode(mode);
  const row = orm
    .update(adminApiKeys)
    .set({
      readAll: permissions.read_all,
      writeAll: permissions.write_all,
      executePaidOperations: permissions.execute_paid_operations,
    })
    .where(and(eq(adminApiKeys.id, id), isNull(adminApiKeys.revokedAt)))
    .returning(API_KEY_FIELDS)
    .get();
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'API key does not exist', 404);
  }
  return toItem(row);
}

/** Issues a new plaintext value for the same row, keeping name and grants. */
export function rotateApiKey(orm: Orm, id: bigint): CreatedAdminApiKey {
  const token = `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('base64url')}`;
  const row = orm
    .update(adminApiKeys)
    .set({
      prefix: token.slice(0, PREFIX_DISPLAY_LENGTH),
      tokenHash: hashToken(token),
      lastUsedAt: null,
    })
    .where(and(eq(adminApiKeys.id, id), isNull(adminApiKeys.revokedAt)))
    .returning(API_KEY_FIELDS)
    .get();
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'API key does not exist', 404);
  }
  return { key: token, item: toItem(row) };
}

/**
 * Resolves a plaintext key to its row and records usage. Returns `null` for an
 * unknown, revoked, malformed, or permission-corrupt key — callers must answer
 * with the same fixed failure either way.
 */
export function authenticateApiKey(orm: Orm, token: string, now = new Date()): AuthenticatedApiKey | null {
  if (token.length === 0) {
    return null;
  }
  const row = orm
    .select({
      id: adminApiKeys.id,
      name: adminApiKeys.name,
      revokedAt: adminApiKeys.revokedAt,
      readAll: adminApiKeys.readAll,
      writeAll: adminApiKeys.writeAll,
      executePaidOperations: adminApiKeys.executePaidOperations,
    })
    .from(adminApiKeys)
    .where(eq(adminApiKeys.tokenHash, hashToken(token)))
    .get();
  if (row === undefined || row.revokedAt !== null) {
    return null;
  }
  const permissions: ApiKeyPermissions = {
    read_all: row.readAll,
    write_all: row.writeAll,
    execute_paid_operations: row.executePaidOperations,
  };
  const mode = modeFromPermissions(permissions);
  if (mode === null) {
    return null;
  }
  orm.update(adminApiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(adminApiKeys.id, row.id)).run();
  return { id: row.id, name: row.name, permissions, mode };
}

/** Rows a direct database edit made unusable; surfaced as a standing warning. */
export function invalidApiKeys(orm: Orm): readonly AdminApiKeyItem[] {
  return orm
    .select(API_KEY_FIELDS)
    .from(adminApiKeys)
    .where(and(isNull(adminApiKeys.revokedAt), eq(adminApiKeys.readAll, false)))
    .all()
    .map(toItem);
}

export function parseCreateApiKeyBody(value: unknown): { readonly name: string; readonly mode: ApiKeyMode } {
  if (!createApiKeyBodyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      `name must be a string of 1-${MAX_NAME_LENGTH} characters and mode must be one of read, read_write, read_paid, all`,
    );
  }
  return { name: value.name, mode: value.mode ?? 'read_paid' };
}

export function parseUpdateApiKeyBody(value: unknown): ApiKeyMode {
  if (!updateApiKeyBodyValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'mode must be one of read, read_write, read_paid, all');
  }
  return value.mode;
}

function toItem(row: ApiKeyRow): AdminApiKeyItem {
  const permissions: ApiKeyPermissions = {
    read_all: row.readAll,
    write_all: row.writeAll,
    execute_paid_operations: row.executePaidOperations,
  };
  return {
    id: row.id.toString(),
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
    mode: modeFromPermissions(permissions),
    permissions,
  };
}
