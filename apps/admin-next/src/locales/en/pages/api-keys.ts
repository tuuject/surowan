/**
 * Pages `apiKeys` group. English is the source catalog; `zh-CN/pages/api-keys.ts`
 * mirrors it key for key.
 */
export const apiKeys = {
  title: 'API keys',
  description:
    'Keys allow the surowan-utils CLI to list and inspect Invocations, read redacted configuration and global/group prompts, export snapshot-authorized media, and replay with temporary prompt overrides. They cannot change production prompts or configuration, or manage keys. Replay calls the model and may incur charges.',
  create: 'Create API key',
  name: 'Name',
  prefix: 'Prefix',
  created: 'Created',
  lastUsed: 'Last used',
  status: 'Status',
  actions: 'Actions',
  active: 'Active',
  revoked: 'Revoked',
  neverUsed: 'Never used',
  empty: 'No API keys created yet.',
  createDescription: 'Choose a name to identify this key, such as a device or integration. Use 1–80 characters.',
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
  revoke: 'Revoke',
  revokeTitle: 'Revoke API key?',
  revokeDescription:
    'Revoke “{{name}}”? It will stop working immediately and cannot be restored. Its metadata will remain in the list.',
  revokeConfirm: 'Revoke key',
  revokedMessage: 'API key revoked',
};
