import { SIGNATURE_SCHEME, findSurfaceSpec, specAccess } from '@surowan/admin-surface';
import { type ApiKeyMode, type ApiKeyPermissions, accessAllowed } from './api-keys.ts';
import { json } from './http.ts';

/**
 * The gate both programmatic credentials share: a bearer API key and a paired
 * client are judged by exactly the same route surface and `access`
 * requirement, and both are excluded from account, credential and API-key
 * management the same way.
 *
 * This module holds the part that needs no server state, so it can be used (and
 * read) without the request dispatch around it. Everything that needs a live
 * `AdminServer` — secret registration, the Invocation replay route and the
 * authenticated dispatch — stays in `index.ts`.
 */
export interface ProgrammaticCredential {
  readonly kind: 'api_key' | 'client';
  readonly id: bigint;
  readonly name: string;
  readonly mode: ApiKeyMode;
  readonly permissions: ApiKeyPermissions;
  /** Display-only for a client; `null` for a key, which has no public half. */
  readonly fingerprint: string | null;
  /** Plaintext bearer key, scrubbed from inspection output; `null` for a signed client. */
  readonly secret: string | null;
}

/** A label for messages and 403 fallbacks; the two credential kinds read differently. */
export function credentialLabel(credential: ProgrammaticCredential): string {
  return credential.kind === 'client' ? 'Paired clients' : 'API keys';
}

/** `Authorization` schemes are case-insensitive; only `Surowan-Signature` may sign. */
export function isSignatureAuthorization(authorization: string): boolean {
  const scheme = `${SIGNATURE_SCHEME} `;
  return authorization.slice(0, scheme.length).toLowerCase() === scheme.toLowerCase();
}

/**
 * The pure half of the shared gate, in evaluation order: the caller's own
 * identity document, the account/credential exclusion, the unknown-route
 * refusal and the per-route permission check. `'allowed'` means the request may
 * proceed to the authenticated dispatch (or to the replay special case).
 */
export function gateProgrammaticCredential(
  request: Request,
  segments: readonly string[],
  credential: ProgrammaticCredential,
): Response | 'allowed' {
  const label = credentialLabel(credential);
  if (segments.length === 1 && segments[0] === 'key' && request.method === 'GET') {
    return json({
      id: credential.id.toString(),
      name: credential.name,
      mode: credential.mode,
      permissions: credential.permissions,
      kind: credential.kind,
      ...(credential.fingerprint === null ? {} : { fingerprint: credential.fingerprint }),
    });
  }
  if (segments[0] === 'auth' || segments[0] === 'api-keys') {
    return json({ error: 'forbidden', message: `${label} cannot manage accounts, credentials or API keys` }, 403);
  }
  const found = findSurfaceSpec(request.method, segments);
  if (found === undefined) {
    return json({ error: 'forbidden', message: `${label} cannot access this route` }, 403);
  }
  const access = specAccess(found.spec);
  if (!accessAllowed(credential.permissions, access)) {
    return json(
      {
        error: 'forbidden',
        message:
          credential.kind === 'client'
            ? `This client lacks ${access} permission; revoke it with surowan clients revoke ${credential.id.toString()}, then pair again with a wider --mode`
            : `This API key lacks ${access} permission; enable it in Admin Panel → API keys`,
      },
      403,
    );
  }
  return 'allowed';
}
