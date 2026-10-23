/**
 * Pages `passkeys` group. English is the source catalog; `zh-CN/pages/passkeys.ts`
 * mirrors it key for key.
 */
export const passkeys = {
  title: 'Passkeys',
  description: 'Sign in with a device passkey instead of a password. Passkeys are tied to this panel public URL.',
  add: 'Add passkey',
  name: 'Name',
  created: 'Created',
  lastUsed: 'Last used',
  neverUsed: 'Never used',
  unusable: 'Registered for a different panel URL; it can no longer be used to sign in here.',
  actions: 'Actions',
  delete: 'Delete',
  empty: 'No passkeys registered yet.',
  deleteTitle: 'Delete passkey "{{name}}"?',
  deleteDescription:
    'This passkey will stop working immediately and cannot be restored. You can register a new one at any time.',
  deleteConfirm: 'Delete passkey',
  deleted: 'Passkey deleted',
  deleteLastDisabled: 'This is the last sign-in method. Set a password above before deleting it.',
  noPasswordHint:
    'No password is set. Add one with the Admin credentials card above before deleting your last passkey.',
  passwordStatus: 'Password',
  passwordSet: 'set',
  passwordNotSet: 'not set',
  passwordDelete: 'Delete password',
  passwordDeleteTitle: 'Delete your password?',
  passwordDeleteDescription:
    'After this, passkeys are the only way to sign in. Your current session stays active until you sign out.',
  passwordDeleteConfirm: 'Delete password',
  passwordDeleted: 'Password deleted',
  unsupported:
    'Passkeys are unavailable in this browser or context. Use a WebAuthn-capable browser over HTTPS (or loopback) to register and use passkeys. Existing passkeys can still be managed below.',
  cancelled: 'Passkey request cancelled',
  discoverableRequired: 'This browser does not support discoverable (passkey) credentials.',
  webauthnFailed: 'The passkey request failed. Try again.',
  registerTitle: 'Add a passkey',
  registerDescription:
    'Name this passkey, then confirm with your device screen lock, fingerprint, or other verification.',
  nameLabel: 'Passkey name',
  namePlaceholder: 'e.g. Work laptop',
  invalidName: 'Enter a name of 1-80 characters.',
  registerConfirm: 'Register passkey',
  registering: 'Registering…',
  registered: 'Passkey registered',
};
