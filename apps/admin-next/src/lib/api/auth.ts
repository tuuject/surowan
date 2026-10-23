import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { call, type Credentials, postJson, type SessionState } from './core.ts';

export function getSession(): Promise<SessionState> {
  return call<SessionState>('/auth/session');
}

function postCredentials(path: string): (credentials: Credentials) => Promise<{ status: string }> {
  return (credentials) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
}

export const createFirstAdmin = postCredentials('/auth/setup');

export const login = postCredentials('/auth/login');

export const updateCredentials = postCredentials('/auth/credentials');

export function logout(): Promise<{ status: string }> {
  return call('/auth/logout', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Passkeys (frontend half of WebAuthn; the ceremony runs in the browser)
// ---------------------------------------------------------------------------
export interface PasskeyItem {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  /** Whether the key was registered for the current panel URL and can sign in. */
  readonly usable: boolean;
}

export interface PasskeyList {
  readonly items: readonly PasskeyItem[];
  readonly has_password: boolean;
}

export function listPasskeys(): Promise<PasskeyList> {
  return call<PasskeyList>('/auth/passkeys');
}

/** The server-generated WebAuthn request options, passed straight into `startAuthentication`. */
export function passkeyLoginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return postJson<PublicKeyCredentialRequestOptionsJSON>('/auth/passkeys/login/options', {});
}

export function passkeyLoginVerify(response: AuthenticationResponseJSON): Promise<{ status: string }> {
  return postJson<{ status: string }>('/auth/passkeys/login/verify', { response });
}

/** The server-generated WebAuthn creation options, passed straight into `startRegistration`. */
export function passkeyRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return postJson<PublicKeyCredentialCreationOptionsJSON>('/auth/passkeys/register/options', {});
}

export function passkeyRegisterVerify(name: string, response: RegistrationResponseJSON): Promise<{ status: string }> {
  return postJson<{ status: string }>('/auth/passkeys/register/verify', { name, response });
}

export function deletePasskey(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Removes the password; the session is rotated and the current one stays valid. */
export function deletePassword(): Promise<{ status: string }> {
  return call<{ status: string }>('/auth/password', { method: 'DELETE' });
}
