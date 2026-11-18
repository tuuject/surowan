import type { KeychainError } from '../../platform/keychain.ts';

/** HTTP status for a keychain failure, shared by every route that can hit one. */
export function keychainErrorStatus(error: KeychainError): number {
  switch (error.code) {
    case 'keychain_exists':
    case 'keychain_in_use':
      return 409;
    case 'keychain_missing':
      return 404;
    case 'keychain_invalid_name':
    case 'keychain_invalid_value':
      return 400;
    default:
      return 500;
  }
}
