import type { SecretStore } from '../../platform/secrets.ts';
import type { Orm } from '../../store/store.ts';
import { json, readCookie, readJsonObject } from './admin-http.ts';
import { createApiKey, listApiKeys, parseCreateApiKeyBody, revokeApiKey } from './api-keys.ts';
import { type AdminAuth, AdminAuthError, type AdminCredentials, type AdminSession } from './auth.ts';
import { parseId } from './audit.ts';
import type { AdminPasskeys } from './passkeys.ts';

const SESSION_COOKIE = 'plasticwan_admin';

/**
 * Adds `Secure` whenever the browser is on HTTPS. Behind a TLS-terminating proxy
 * the request itself arrives over plain HTTP, so the Origin the browser sends
 * with every auth POST is what reveals it. A forged Origin only changes the
 * caller's own cookie, and a plain-HTTP loopback panel keeps working because
 * browsers refuse to store a Secure cookie there.
 */
function cookieAttributes(request: Request, url: URL): string {
  const secure = url.protocol === 'https:' || request.headers.get('origin')?.startsWith('https://') === true;
  return `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

async function readCredentials(request: Request): Promise<AdminCredentials> {
  const record = await readJsonObject(request);
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new AdminAuthError(400, 'invalid_body', 'username and password must be strings');
  }
  return { username, password };
}

export interface AdminAuthHandlerDeps {
  readonly auth: AdminAuth;
  readonly passkeys: AdminPasskeys | undefined;
  readonly orm: Orm;
  readonly secrets: SecretStore | undefined;
}

/**
 * The outcome of the pre-session half of `/api`: either a route answered, or the
 * request carried a valid panel session and the remaining routes may run.
 */
export type AdminAuthOutcome =
  | { readonly kind: 'session'; readonly session: AdminSession }
  | { readonly kind: 'response'; readonly response: Response };

/**
 * Session, passkey, credential and API-key routes. These run before every other
 * `/api` route: the session they establish is what authorizes the rest, and API
 * key management is session-only.
 */
export function createAdminAuthHandler(deps: AdminAuthHandlerDeps) {
  const { auth, passkeys, orm, secrets } = deps;

  const sessionCookie = (request: Request, url: URL, token: string): string => {
    const maxAge = Math.floor(auth.sessionTtlMs / 1000);
    return `${SESSION_COOKIE}=${token}; ${cookieAttributes(request, url)}; Max-Age=${maxAge}`;
  };

  const passkeyRequest = async (
    request: Request,
    url: URL,
    segments: readonly string[],
    clientAddress: string,
  ): Promise<Response> => {
    if (passkeys === undefined) {
      return json({ error: 'passkeys_disabled', message: 'Configure admin.public_url to enable passkeys' }, 404);
    }
    const route = segments.join('/');
    const sessionToken = readCookie(request, SESSION_COOKIE);
    const challengeCookie = 'plasticwan_passkey';
    const challengeToken = readCookie(request, challengeCookie);
    if (request.method !== 'GET') {
      passkeys.checkOrigin(request.headers.get('origin'));
      passkeys.throttle(clientAddress);
    }
    const optionsResponse = (result: { options: unknown; token: string }): Response =>
      json(result.options, 200, `${challengeCookie}=${result.token}; ${cookieAttributes(request, url)}; Max-Age=300`);
    if (route === 'auth/passkeys/login/options' && request.method === 'POST') {
      return optionsResponse(await passkeys.loginOptions(challengeToken));
    }
    if (route === 'auth/passkeys/login/verify' && request.method === 'POST') {
      const token = await passkeys.login(await readJsonObject(request, 65_536), challengeToken);
      return json({ status: 'ok' }, 200, sessionCookie(request, url, token));
    }
    const session = auth.authenticate(sessionToken);
    if (session === null) {
      return json({ error: 'unauthenticated', message: 'Admin session is required' }, 401);
    }
    if (route === 'auth/passkeys' && request.method === 'GET') {
      return json(passkeys.list(session.userId));
    }
    if (route === 'auth/passkeys/register/options' && request.method === 'POST') {
      return optionsResponse(await passkeys.registrationOptions(sessionToken, challengeToken));
    }
    if (route === 'auth/passkeys/register/verify' && request.method === 'POST') {
      await passkeys.register(await readJsonObject(request, 65_536), challengeToken, sessionToken);
      return json({ status: 'ok' });
    }
    if (segments[1] === 'passkeys' && segments.length === 3 && request.method === 'DELETE') {
      passkeys.remove(session.userId, parseId(segments[2] ?? '', 'id'));
      return json({ status: 'ok' });
    }
    if (route === 'auth/password' && request.method === 'DELETE') {
      const token = auth.removePassword(session.userId, passkeys.rpId);
      return json({ status: 'ok' }, 200, sessionCookie(request, url, token));
    }
    return json({ error: 'method_not_allowed', message: 'Unsupported passkey operation' }, 405);
  };

  /**
   * Answers the auth routes, then gates the rest of `/api` on a panel session.
   * A `401` here is the last thing an unauthenticated request ever sees.
   */
  const handle = async (
    request: Request,
    url: URL,
    segments: readonly string[],
    clientAddress: string,
  ): Promise<AdminAuthOutcome> => {
    const route = segments.join('/');
    if (route === 'auth/session' && request.method === 'GET') {
      const session = auth.authenticate(readCookie(request, SESSION_COOKIE));
      return {
        kind: 'response',
        response: json({
          setup_required: auth.setupRequired(),
          authenticated: session !== null,
          username: session?.username ?? null,
          expires_at: session?.expiresAt ?? null,
          passkeys_enabled: passkeys !== undefined,
          has_password: session === null ? null : auth.hasPassword(session.userId),
        }),
      };
    }
    if (segments[0] === 'auth' && (segments[1] === 'passkeys' || segments[1] === 'password')) {
      return { kind: 'response', response: await passkeyRequest(request, url, segments, clientAddress) };
    }
    if (route === 'auth/setup' && request.method === 'POST') {
      const token = await auth.createFirstUser(await readCredentials(request));
      return { kind: 'response', response: json({ status: 'ok' }, 200, sessionCookie(request, url, token)) };
    }
    if (route === 'auth/login' && request.method === 'POST') {
      const token = await auth.login(await readCredentials(request), new Date(), clientAddress);
      return { kind: 'response', response: json({ status: 'ok' }, 200, sessionCookie(request, url, token)) };
    }
    if (route === 'auth/logout' && request.method === 'POST') {
      auth.logout(readCookie(request, SESSION_COOKIE));
      return {
        kind: 'response',
        response: json({ status: 'ok' }, 200, `${SESSION_COOKIE}=; ${cookieAttributes(request, url)}; Max-Age=0`),
      };
    }
    const session = auth.authenticate(readCookie(request, SESSION_COOKIE));
    if (session === null) {
      return {
        kind: 'response',
        response: json({ error: 'unauthenticated', message: 'Admin session is required' }, 401),
      };
    }
    if (route === 'auth/credentials' && request.method === 'POST') {
      const token = await auth.changeCredentials(session.userId, await readCredentials(request));
      return { kind: 'response', response: json({ status: 'ok' }, 200, sessionCookie(request, url, token)) };
    }
    // API key management is session-only: an Authorization header never
    // reaches this block, so a key cannot mint, list, or revoke keys.
    if (route === 'api-keys' && request.method === 'GET') {
      return { kind: 'response', response: json({ items: listApiKeys(orm) }) };
    }
    if (route === 'api-keys' && request.method === 'POST') {
      const created = createApiKey(orm, parseCreateApiKeyBody(await readJsonObject(request)));
      secrets?.remember(created.key);
      return { kind: 'response', response: json(created) };
    }
    if (segments[0] === 'api-keys' && segments.length === 2 && request.method === 'DELETE') {
      revokeApiKey(orm, parseId(segments[1] ?? '', 'id'));
      return { kind: 'response', response: json({ status: 'ok' }) };
    }
    return { kind: 'session', session };
  };

  return { handle };
}
