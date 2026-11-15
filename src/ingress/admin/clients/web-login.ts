import { and, eq } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { Orm } from '../../../store/store.ts';
import { adminPairings } from '../../../store/schema/index.ts';
import { type AdminAuth, AdminAuthError, hashToken } from '../auth.ts';
import { readJsonObject } from '../http.ts';

const MAX_BODY_BYTES = 1_024;

const bodyValidator = Compile(
  Type.Object({ code: Type.String({ pattern: '^pwp_[A-Za-z0-9_-]{32}$' }) }, { additionalProperties: false }),
);

/**
 * `POST /api/auth/pairing`: exchanges a `web` ticket from
 * `surowan pairing create --web` for a panel session.
 *
 * The code is the whole proof. It is minted by someone with shell access to the
 * deployment, carries 192 random bits, lives at most an hour and works once, so
 * it needs neither the password throttle nor a key proof. A client ticket is
 * unknown here, exactly as a web ticket is unknown to `POST /api/pairing/claim`,
 * so neither endpoint can turn the other's code into its own credential or burn
 * it. The lookup, the state checks, the consume and the session insert share one
 * immediate transaction, so two simultaneous claims yield one session.
 */
export async function claimWebPairing(
  orm: Orm,
  auth: AdminAuth,
  request: Request,
  clock: () => Date = () => new Date(),
): Promise<string> {
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  // A malformed code is `invalid_body`, never `pairing_code_invalid`, so a probe
  // learns nothing about which code-shaped strings exist.
  if (!bodyValidator.Check(body)) {
    throw new AdminAuthError(400, 'invalid_body', 'Body must be { code }');
  }
  const codeHash = hashToken(body.code);
  return orm.transaction(
    () => {
      const now = clock();
      const ticket = orm
        .select({
          id: adminPairings.id,
          userId: adminPairings.userId,
          expiresAt: adminPairings.expiresAt,
          consumedAt: adminPairings.consumedAt,
          canceledAt: adminPairings.canceledAt,
        })
        .from(adminPairings)
        .where(and(eq(adminPairings.codeHash, codeHash), eq(adminPairings.purpose, 'web')))
        .get();
      if (ticket === undefined || ticket.canceledAt !== null || ticket.userId === null) {
        throw new AdminAuthError(400, 'pairing_code_invalid', 'Pairing code is unknown or was canceled');
      }
      if (ticket.consumedAt !== null) {
        throw new AdminAuthError(409, 'pairing_code_used', 'Pairing code was already used');
      }
      if (ticket.expiresAt <= now.toISOString()) {
        throw new AdminAuthError(400, 'pairing_code_expired', 'Pairing code has expired');
      }
      orm.update(adminPairings).set({ consumedAt: now.toISOString() }).where(eq(adminPairings.id, ticket.id)).run();
      return auth.createVerifiedSession(ticket.userId, now);
    },
    { behavior: 'immediate' },
  );
}
