import { AdminAuth, type AdminCredentials } from '../../src/ingress/admin/auth.ts';
import type { Orm } from '../../src/store/store.ts';

/**
 * Creates the administrator a test signs in as. The panel has no web setup
 * route: a real deployment gets its first account from `pairing create --web`
 * (a password-less `admin`) or from `admin-account`. Tests that need a password
 * take the `admin-account` path here, then sign in through the real
 * `POST /api/auth/login`.
 */
export async function createAdminAccount(orm: Orm, credentials: AdminCredentials): Promise<void> {
  await new AdminAuth(orm, 12).createOrResetAccount(credentials, { revokePasskeys: false });
}
