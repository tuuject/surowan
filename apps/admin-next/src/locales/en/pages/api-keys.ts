/**
 * Pages `apiKeys` group. English is the source catalog; `zh-CN/pages/api-keys.ts`
 * mirrors it key for key.
 */
export const apiKeys = {
  title: 'API keys',
  create: 'Create API key',
  name: 'Name',
  prefix: 'Prefix',
  mode: 'Mode',
  modes: {
    read: 'Read only',
    read_write: 'Read + write',
    read_paid: 'Read + paid',
    all: 'All',
  },
  modeHints: {
    read: 'Read every audit, configuration and prompt view. No changes, no billed calls.',
    read_write:
      'Read and change configuration, chats, prompts, memos, dictionary, group memory, warnings and Playground inputs. No billed calls.',
    read_paid:
      'Read and run billed operations such as replay, health checks, image generation and dictionary merge preview. No configuration or state changes.',
    all: 'Read, write and run billed operations. Playground releases need both write and paid.',
  },
  invalidPermissions: 'Invalid permissions',
  invalidPermissionsHint: 'This key has invalid permissions and cannot sign in. Save a mode to fix it.',
  created: 'Created',
  lastUsed: 'Last used',
  status: 'Status',
  actions: 'Actions',
  active: 'Active',
  revoked: 'Revoked',
  neverUsed: 'Never used',
  empty: 'No API keys created yet.',
  createDescription: 'Choose a name and a permission mode. Use 1–80 characters for the name.',
  namePlaceholder: 'e.g. Laptop CLI',
  invalidName: 'Enter a name of 1–80 characters.',
  createConfirm: 'Create key',
  creating: 'Creating…',
  saveTitle: 'Save your API key',
  saveDescription:
    'This key is shown only once. Copy it to a password manager or a secure environment variable before closing. It cannot be recovered after closing, leaving or refreshing this page.',
  keyLabel: 'API key',
  copy: 'Copy API key',
  copyFailed: 'Could not copy. Select the key and copy it manually.',
  done: 'Done',
  editMode: 'Change mode',
  editModeDescription: 'Change the permission mode for “{{name}}”. The key value does not change.',
  modeUpdated: 'API key mode updated',
  rotate: 'Rotate',
  rotateTitle: 'Rotate API key?',
  rotateDescription:
    'Issue a new value for “{{name}}”? The old value stops working immediately; the name and mode stay the same.',
  rotateConfirm: 'Rotate key',
  revoke: 'Revoke',
  revokeTitle: 'Revoke API key?',
  revokeDescription:
    'Revoke “{{name}}”? It will stop working immediately and cannot be restored. Its metadata will remain in the list.',
  revokeConfirm: 'Revoke key',
  revokedMessage: 'API key revoked',
};
