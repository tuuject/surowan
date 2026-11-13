/**
 * Pages `telegram` group. English is the source catalog;
 * `zh-CN/pages/telegram.ts` mirrors it key for key.
 */
export const telegram = {
  title: 'Telegram settings',
  description: 'Connect Surowan to Telegram.',
  connectionTitle: 'Connection',
  fieldStatus: 'Status',
  fieldSince: 'Since',
  fieldBot: 'Bot',
  noBot: 'No identity yet',
  status: {
    disabled: 'Disabled',
    connected: 'Connected',
    network_error: 'Network error',
    config_error: 'Configuration error',
  },
  reason: {
    unauthorized: 'The token was rejected.',
    conflict: 'The token is being used by another process.',
    token_unreadable: 'The token source could not be read.',
  },
  tokenTitle: 'Bot Token',
  tokenConfigured: 'A token is configured.',
  tokenMissing: 'No token is configured.',
  sectionMissing: 'No Telegram settings yet. Saving a token creates them.',
  tokenLabel: 'New Bot Token',
  tokenPlaceholder: '123456:ABC-DEF…',
  tokenHint: 'Paste the token from @BotFather. It is never shown again after saving.',
  save: 'Save token',
  saving: 'Saving…',
  saved: 'Telegram token saved',
  clear: 'Clear token',
  clearTitle: 'Clear the Telegram Bot Token?',
  clearDescription: 'Telegram stops and disconnects. Your other Telegram settings are kept. This cannot be undone.',
  clearConfirm: 'Clear token',
  cleared: 'Telegram token cleared',
  readFailed: 'Failed to read the Telegram settings',
};
