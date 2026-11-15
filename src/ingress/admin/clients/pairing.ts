import { and, eq, gt, isNull } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SIGNATURE_PATTERN } from '@surowan/admin-surface';
import { asRunResult, type Orm } from '../../../store/store.ts';
import { adminPairings } from '../../../store/schema/index.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { AdminAuthError, hashToken } from '../auth.ts';
import { json, readJsonObject } from '../http.ts';
import { ensureInstanceId, findActiveClientByPublicKey, insertClient } from './index.ts';
import { buildPairingProof, isValidPublicKey, publicKeyFingerprint, verifyEd25519 } from './keys.ts';

/**
 * `POST /api/pairing/claim`: the one unauthenticated write on the Admin API.
 *
 * A pairing code is a short-lived bearer secret, so claiming it also requires a
 * signature by the very key being registered. That is what a stolen code alone
 * cannot do, and why a pre-bound ticket (created with `--public-key`) cannot be
 * redirected to an attacker's key. Nothing is consumed until every check has
 * passed, so a wrong key or a bad proof does not burn the ticket.
 */
const CLAIM_CODE_PATTERN = /^pwp_[A-Za-z0-9_-]{32}$/;
const MAX_CLAIM_BODY_BYTES = 4_096;

const claimBodyValidator = Compile(
  Type.Object(
    {
      code: Type.String({ pattern: '^pwp_[A-Za-z0-9_-]{32}$' }),
      public_key: Type.String({ minLength: 1, maxLength: 64 }),
      proof: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
);

interface ClaimBody {
  readonly code: string;
  readonly publicKey: string;
  readonly proof: string;
}

export async function claimPairing(
  orm: Orm,
  request: Request,
  clock: () => Date = () => new Date(),
): Promise<Response> {
  const received = clock();
  const body = parseClaimBody(await readJsonObject(request, MAX_CLAIM_BODY_BYTES));
  const pairing = orm
    .select({
      id: adminPairings.id,
      name: adminPairings.name,
      publicKey: adminPairings.publicKey,
      expiresAt: adminPairings.expiresAt,
      consumedAt: adminPairings.consumedAt,
      canceledAt: adminPairings.canceledAt,
      readAll: adminPairings.readAll,
      writeAll: adminPairings.writeAll,
      executePaidOperations: adminPairings.executePaidOperations,
    })
    .from(adminPairings)
    // A web sign-in ticket is unknown here: it must never become a client, and
    // naming it must not burn it.
    .where(and(eq(adminPairings.codeHash, hashToken(body.code)), eq(adminPairings.purpose, 'client')))
    .get();
  if (pairing === undefined || pairing.canceledAt !== null) {
    throw new AdminAuthError(400, 'pairing_code_invalid', 'Pairing code is unknown or was canceled');
  }
  if (pairing.consumedAt !== null) {
    throw new AdminAuthError(409, 'pairing_code_used', 'Pairing code was already used');
  }
  if (pairing.expiresAt <= received.toISOString()) {
    throw new AdminAuthError(400, 'pairing_code_expired', 'Pairing code has expired');
  }
  if (pairing.publicKey !== null && pairing.publicKey !== body.publicKey) {
    throw new AdminAuthError(401, 'pairing_public_key_mismatch', 'Pairing code is bound to another public key');
  }
  const proof = await buildPairingProof(body.code, body.publicKey);
  if (!(await verifyEd25519(body.publicKey, new TextEncoder().encode(proof), body.proof))) {
    throw new AdminAuthError(401, 'pairing_proof_invalid', 'Pairing proof signature is invalid');
  }
  // Hashing happens before the synchronous transaction so the write path never awaits.
  const fingerprint = await publicKeyFingerprint(body.publicKey);
  if (fingerprint === null) {
    throw new AdminAuthError(400, 'invalid_body', 'Body must be { code, public_key, proof }');
  }
  const permissions = {
    read_all: pairing.readAll,
    write_all: pairing.writeAll,
    execute_paid_operations: pairing.executePaidOperations,
  };
  // One immediate transaction: the conditional consume is what makes a double
  // claim yield exactly one client even if two requests arrive at once. The
  // expiry check is repeated here with a fresh clock reading and again in the
  // consume predicate: the proof verification above is asynchronous, so a
  // ticket that had a few seconds left when the request arrived may already be
  // dead, and no client row may be created for it.
  const client = orm.transaction(
    () => {
      const now = clock();
      const live = orm
        .select({
          expiresAt: adminPairings.expiresAt,
          consumedAt: adminPairings.consumedAt,
          canceledAt: adminPairings.canceledAt,
        })
        .from(adminPairings)
        .where(eq(adminPairings.id, pairing.id))
        .get();
      if (live === undefined || live.canceledAt !== null) {
        throw new AdminAuthError(400, 'pairing_code_invalid', 'Pairing code is unknown or was canceled');
      }
      if (live.consumedAt !== null) {
        throw new AdminQueryError('pairing_code_used', 'Pairing code was already used', 409);
      }
      if (live.expiresAt <= now.toISOString()) {
        throw new AdminAuthError(400, 'pairing_code_expired', 'Pairing code has expired');
      }
      if (findActiveClientByPublicKey(orm, body.publicKey) !== undefined) {
        throw new AdminQueryError('client_already_paired', 'This public key already has an active client', 409);
      }
      const created = insertClient(
        orm,
        { name: pairing.name, publicKey: body.publicKey, fingerprint, permissions },
        now,
      );
      const consumed = asRunResult(
        orm
          .update(adminPairings)
          .set({ consumedAt: now.toISOString(), clientId: BigInt(created.id) })
          .where(
            and(
              eq(adminPairings.id, pairing.id),
              isNull(adminPairings.consumedAt),
              isNull(adminPairings.canceledAt),
              gt(adminPairings.expiresAt, now.toISOString()),
            ),
          )
          .run(),
      );
      if (consumed.changes === 0) {
        // Lost the race: say which way so an agent knows whether to mint a new
        // code (expired) or ask the operator to revoke the old client (used).
        const after = orm
          .select({
            expiresAt: adminPairings.expiresAt,
            canceledAt: adminPairings.canceledAt,
          })
          .from(adminPairings)
          .where(eq(adminPairings.id, pairing.id))
          .get();
        if (after !== undefined && after.canceledAt !== null) {
          throw new AdminAuthError(400, 'pairing_code_invalid', 'Pairing code is unknown or was canceled');
        }
        if (after !== undefined && after.expiresAt <= now.toISOString()) {
          throw new AdminAuthError(400, 'pairing_code_expired', 'Pairing code has expired');
        }
        throw new AdminQueryError('pairing_code_used', 'Pairing code was already used', 409);
      }
      return created;
    },
    { behavior: 'immediate' },
  );
  return json(
    {
      client: {
        id: client.id,
        name: client.name,
        fingerprint: client.fingerprint,
        mode: client.mode,
        permissions: client.permissions,
        created_at: client.created_at,
      },
      instance_id: ensureInstanceId(orm, clock()),
    },
    201,
  );
}

/**
 * Shape only; every value is re-checked against its pattern so a body that
 * TypeBox accepted cannot smuggle anything into a canonical string or a SQL
 * parameter. A malformed code is `invalid_body`, never `pairing_code_invalid`,
 * so a probe cannot learn whether a code-shaped string exists.
 */
function parseClaimBody(value: Record<string, unknown>): ClaimBody {
  if (!claimBodyValidator.Check(value)) {
    throw new AdminAuthError(400, 'invalid_body', 'Body must be { code, public_key, proof }');
  }
  const { code, public_key: publicKey, proof } = value;
  if (!CLAIM_CODE_PATTERN.test(code) || !isValidPublicKey(publicKey) || !SIGNATURE_PATTERN.test(proof)) {
    throw new AdminAuthError(400, 'invalid_body', 'Body must be { code, public_key, proof }');
  }
  return { code, publicKey, proof };
}
