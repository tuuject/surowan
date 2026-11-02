import type { AdminClient } from '../client.ts';
import { SESSION_COOKIE } from '../client.ts';
import { CliError, usageError } from '../errors.ts';
/**
 * The panel password is exchanged for a session token by the same endpoint the
 * browser login page uses. The token authorizes exactly what the panel does,
 * which is why the CLI can offer the panel's write surface at all: an API key
 * is deliberately limited to inspection and replay.
 */
export interface PanelLoginInput {
  readonly username: string;
  readonly password: string;
}

export interface PanelLoginResult {
  readonly session: string;
  readonly username: string;
}

/**
 * Signs in and returns the session token. The server sets the cookie on a
 * successful `POST /api/auth/login`; the token is parsed out of `set-cookie`
 * because the CLI has no cookie jar.
 */
export async function panelLogin(client: AdminClient, input: PanelLoginInput): Promise<PanelLoginResult> {
  if (input.username.length < 3 || input.username.length > 32) {
    throw usageError('invalid_username', 'username must be 3 to 32 characters');
  }
  if (input.password.length < 12 || input.password.length > 200) {
    throw usageError('invalid_password', 'password must be 12 to 200 characters');
  }
  const token = await client.loginWithPassword(input.username, input.password);
  const session = sessionFromSetCookie(token);
  if (session === null) {
    throw new CliError('invalid_response', 'the login response did not set a session cookie');
  }
  return { session, username: input.username };
}

/**
 * Reads the session value out of a `set-cookie` header. A server may set more
 * than one cookie, so the header list is scanned rather than parsed as one.
 */
export function sessionFromSetCookie(headers: readonly string[]): string | null {
  for (const header of headers) {
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) {
        continue;
      }
      if (part.slice(0, separator).trim() !== SESSION_COOKIE) {
        continue;
      }
      const value = part.slice(separator + 1).trim();
      if (value.length > 0) {
        return value;
      }
    }
  }
  return null;
}
