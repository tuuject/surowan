import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { INSTANCE_ID_PATTERN, nonceExpiresAtSeconds } from '@surowan/admin-surface';
import { asRunResult, type Orm } from '../../../store/store.ts';
import { adminClientNonces, adminClients, adminPairings, appState } from '../../../store/schema/index.ts';
import { type ApiKeyMode, type ApiKeyPermissions, modeFromPermissions, permissionsFromMode } from '../api-keys.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { hashToken } from '../auth.ts';
import { generatePairingCode, publicKeyFingerprint } from './keys.ts';

/**
 * Paired Admin clients: the stored side of the signature scheme.
 *
 * A client is an Ed25519 identity that signs each request; the server keeps only
 * its public key and the same three permission booleans an API key has, so a
 * client reaches exactly the surface an API key of the same mode would. Pairing
 * tickets are single-use and short-lived, and only the SHA-256 digest of a
 * `pwp_` code is stored — the plaintext exists only in the `pairing create`
 * output the operator hands to the client.
 */
export const DEFAULT_PAIRING_TTL_SECONDS = 300;
export const MIN_PAIRING_TTL_SECONDS = 60;
export const MAX_PAIRING_TTL_SECONDS = 3_600;
const INSTANCE_ID_KEY = 'admin_instance_id';
const INSTANCE_ID_BYTES = 16;

export interface AdminClientItem {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly mode: ApiKeyMode | null;
  readonly permissions: ApiKeyPermissions;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface AuthenticatedClient {
  readonly id: bigint;
  readonly name: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly permissions: ApiKeyPermissions;
  readonly mode: ApiKeyMode;
}

export interface PairingItem {
  readonly id: string;
  readonly name: string;
  readonly mode: ApiKeyMode | null;
  readonly permissions: ApiKeyPermissions;
  /** Fingerprint of the pre-bound key, or `null` when any key may claim the code. */
  readonly public_key_fingerprint: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface CreatedPairing {
  /** Plaintext code; the only copy that will ever exist outside the operator. */
  readonly code: string;
  readonly item: PairingItem;
}

export interface CreatePairingInput {
  readonly name: string;
  readonly mode: ApiKeyMode;
  readonly ttlSeconds: number;
  /** Pre-bound key: only this exact key may claim the ticket. */
  readonly publicKey: string | null;
}

const CLIENT_FIELDS = {
  id: adminClients.id,
  name: adminClients.name,
  fingerprint: adminClients.fingerprint,
  createdAt: adminClients.createdAt,
  lastUsedAt: adminClients.lastUsedAt,
  revokedAt: adminClients.revokedAt,
  readAll: adminClients.readAll,
  writeAll: adminClients.writeAll,
  executePaidOperations: adminClients.executePaidOperations,
} as const;

const PAIRING_FIELDS = {
  id: adminPairings.id,
  name: adminPairings.name,
  publicKey: adminPairings.publicKey,
  createdAt: adminPairings.createdAt,
  expiresAt: adminPairings.expiresAt,
  readAll: adminPairings.readAll,
  writeAll: adminPairings.writeAll,
  executePaidOperations: adminPairings.executePaidOperations,
} as const;

interface PairingRow {
  readonly id: bigint;
  readonly name: string;
  readonly publicKey: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly readAll: boolean;
  readonly writeAll: boolean;
  readonly executePaidOperations: boolean;
}

interface ClientRow {
  readonly id: bigint;
  readonly name: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly readAll: boolean;
  readonly writeAll: boolean;
  readonly executePaidOperations: boolean;
}

/**
 * The instance identity signed requests are bound to, so a signature captured
 * from one deployment is worthless against another. Whichever process needs it
 * first creates it; `ON CONFLICT DO NOTHING` plus the re-read keeps concurrent
 * creators on the same value.
 */
export function ensureInstanceId(orm: Orm, now = new Date()): string {
  const read = (): string | undefined =>
    orm.select({ value: appState.value }).from(appState).where(eq(appState.key, INSTANCE_ID_KEY)).get()?.value;
  const existing = read();
  if (existing !== undefined && INSTANCE_ID_PATTERN.test(existing)) {
    // The steady state is a read: a signature check must not take a write lock.
    return existing;
  }
  const candidate = `ins_${randomBytes(INSTANCE_ID_BYTES).toString('base64url')}`;
  orm
    .insert(appState)
    .values({ key: INSTANCE_ID_KEY, value: candidate, updatedAt: now.toISOString() })
    .onConflictDoNothing({ target: appState.key })
    .run();
  const created = read();
  if (created === undefined || !INSTANCE_ID_PATTERN.test(created)) {
    throw new Error(`${INSTANCE_ID_KEY} in app_state is missing or malformed`);
  }
  return created;
}

export async function createPairing(orm: Orm, input: CreatePairingInput, now = new Date()): Promise<CreatedPairing> {
  const code = generatePairingCode();
  const permissions = permissionsFromMode(input.mode);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString();
  const row = orm
    .insert(adminPairings)
    .values({
      name: input.name,
      codeHash: hashToken(code),
      publicKey: input.publicKey,
      createdAt,
      expiresAt,
      readAll: permissions.read_all,
      writeAll: permissions.write_all,
      executePaidOperations: permissions.execute_paid_operations,
    })
    .returning(PAIRING_FIELDS)
    .get();
  if (row === undefined) {
    throw new Error('admin_pairings insert returned no row');
  }
  return { code, item: await toPairingItem(row) };
}

/** Pending only: an expired ticket can no longer pair anything. */
export async function listPendingPairings(orm: Orm, now = new Date()): Promise<readonly PairingItem[]> {
  const rows = orm
    .select(PAIRING_FIELDS)
    .from(adminPairings)
    .where(
      and(
        isNull(adminPairings.consumedAt),
        isNull(adminPairings.canceledAt),
        gt(adminPairings.expiresAt, now.toISOString()),
      ),
    )
    .orderBy(desc(adminPairings.id))
    .all();
  return await Promise.all(rows.map((row) => toPairingItem(row)));
}

/** Cancelling an already consumed or cancelled ticket is a not-found error, not a no-op. */
export function cancelPairing(orm: Orm, id: bigint, now = new Date()): void {
  const result = asRunResult(
    orm
      .update(adminPairings)
      .set({ canceledAt: now.toISOString() })
      .where(and(eq(adminPairings.id, id), isNull(adminPairings.consumedAt), isNull(adminPairings.canceledAt)))
      .run(),
  );
  if (result.changes === 0) {
    throw new AdminQueryError('not_found', 'Pairing does not exist or is no longer pending', 404);
  }
}

export function insertClient(
  orm: Orm,
  input: {
    readonly name: string;
    readonly publicKey: string;
    /** `SHA256:…` of the key, computed by the caller outside the transaction. */
    readonly fingerprint: string;
    readonly permissions: ApiKeyPermissions;
  },
  now = new Date(),
): AdminClientItem {
  const row = orm
    .insert(adminClients)
    .values({
      name: input.name,
      publicKey: input.publicKey,
      fingerprint: input.fingerprint,
      createdAt: now.toISOString(),
      readAll: input.permissions.read_all,
      writeAll: input.permissions.write_all,
      executePaidOperations: input.permissions.execute_paid_operations,
    })
    .returning(CLIENT_FIELDS)
    .get();
  if (row === undefined) {
    throw new Error('admin_clients insert returned no row');
  }
  return toClientItem(row);
}

export function listClients(orm: Orm): readonly AdminClientItem[] {
  return orm.select(CLIENT_FIELDS).from(adminClients).orderBy(desc(adminClients.id)).all().map(toClientItem);
}

/** Revokes an active client; revoking twice is a not-found error, not a no-op. */
export function revokeClient(orm: Orm, id: bigint, now = new Date()): AdminClientItem {
  const row = orm
    .update(adminClients)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(adminClients.id, id), isNull(adminClients.revokedAt)))
    .returning(CLIENT_FIELDS)
    .get();
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'Client does not exist or is already revoked', 404);
  }
  return toClientItem(row);
}

export function findActiveClientByPublicKey(orm: Orm, publicKey: string): { readonly id: bigint } | undefined {
  return orm
    .select({ id: adminClients.id })
    .from(adminClients)
    .where(and(eq(adminClients.publicKey, publicKey), isNull(adminClients.revokedAt)))
    .get();
}

/**
 * Resolves the caller of a signed request. A revoked client, or one whose grant
 * columns were edited into an illegal combination, is `null` exactly like an
 * unknown client: the caller answers one fixed 401 and never explains why.
 */
export function authenticateClient(orm: Orm, id: bigint): AuthenticatedClient | null {
  const row = orm
    .select({
      id: adminClients.id,
      name: adminClients.name,
      fingerprint: adminClients.fingerprint,
      publicKey: adminClients.publicKey,
      revokedAt: adminClients.revokedAt,
      readAll: adminClients.readAll,
      writeAll: adminClients.writeAll,
      executePaidOperations: adminClients.executePaidOperations,
    })
    .from(adminClients)
    .where(eq(adminClients.id, id))
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
  return { id: row.id, name: row.name, fingerprint: row.fingerprint, publicKey: row.publicKey, permissions, mode };
}

export function touchClient(orm: Orm, id: bigint, now = new Date()): void {
  orm.update(adminClients).set({ lastUsedAt: now.toISOString() }).where(eq(adminClients.id, id)).run();
}

/**
 * Records a verified nonce and reports whether it was new. The row is kept
 * until the request's own timestamp can no longer pass the freshness window;
 * deriving it from `ts` rather than from receipt time is what stops a request
 * signed ahead of the server clock from being replayable in the second after
 * its nonce would otherwise expire. The sweep is scoped to this client so an
 * insert can never scan the whole table.
 */
export function recordNonce(
  orm: Orm,
  clientId: bigint,
  nonce: string,
  timestampSeconds: number,
  now = new Date(),
): boolean {
  orm.run(sql`DELETE FROM admin_client_nonces WHERE client_id = ${clientId} AND expires_at <= ${now.toISOString()}`);
  const result = asRunResult(
    orm
      .insert(adminClientNonces)
      .values({
        clientId,
        nonce,
        expiresAt: new Date(nonceExpiresAtSeconds(timestampSeconds) * 1_000).toISOString(),
      })
      .onConflictDoNothing()
      .run(),
  );
  return result.changes > 0;
}

function toClientItem(row: ClientRow): AdminClientItem {
  const permissions: ApiKeyPermissions = {
    read_all: row.readAll,
    write_all: row.writeAll,
    execute_paid_operations: row.executePaidOperations,
  };
  return {
    id: row.id.toString(),
    name: row.name,
    fingerprint: row.fingerprint,
    mode: modeFromPermissions(permissions),
    permissions,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
  };
}

async function toPairingItem(row: PairingRow): Promise<PairingItem> {
  const permissions: ApiKeyPermissions = {
    read_all: row.readAll,
    write_all: row.writeAll,
    execute_paid_operations: row.executePaidOperations,
  };
  return {
    id: row.id.toString(),
    name: row.name,
    mode: modeFromPermissions(permissions),
    permissions,
    public_key_fingerprint: row.publicKey === null ? null : await publicKeyFingerprint(row.publicKey),
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}
