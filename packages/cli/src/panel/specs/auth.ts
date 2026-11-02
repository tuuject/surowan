import type { EndpointSpec } from '../types.ts';

/**
 * Session, account, passkey and API-key routes. These are the panel's
 * Settings → Account and Manage → API keys pages. `login` itself is a local
 * action (it writes the credentials file) and is not a row here.
 */
export const AUTH_SPECS: readonly EndpointSpec[] = [
  {
    command: 'setup',
    method: 'POST',
    path: 'auth/setup',
    body: true,
    session: 'save',
    summary: 'Create the first administrator account and store its session',
  },
  {
    command: 'logout',
    method: 'POST',
    path: 'auth/logout',
    session: 'clear',
    summary: 'End the panel session and delete the stored credential',
  },
  {
    command: 'session show',
    method: 'GET',
    path: 'auth/session',
    summary: 'Show setup state, the signed-in account and passkey availability',
  },
  {
    command: 'account update',
    method: 'POST',
    path: 'auth/credentials',
    body: true,
    session: 'save',
    summary: 'Change the administrator username and password (revokes every session)',
  },
  {
    command: 'passkey list',
    method: 'GET',
    path: 'auth/passkeys',
    summary: 'List registered passkeys',
  },
  {
    command: 'passkey delete',
    method: 'DELETE',
    path: 'auth/passkeys/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    confirm: 'destructive',
    summary: 'Delete one passkey',
  },
  {
    command: 'password delete',
    method: 'DELETE',
    path: 'auth/password',
    confirm: 'destructive',
    session: 'save',
    summary: 'Delete the password and keep passkey-only sign-in',
  },
  {
    command: 'api-key list',
    method: 'GET',
    path: 'api-keys',
    summary: 'List programmatic API keys',
  },
  {
    command: 'api-key create',
    method: 'POST',
    path: 'api-keys',
    body: true,
    summary: 'Create an API key; the plaintext appears once in the response',
  },
  {
    command: 'api-key revoke',
    method: 'DELETE',
    path: 'api-keys/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    confirm: 'destructive',
    summary: 'Revoke an API key permanently',
  },
];
