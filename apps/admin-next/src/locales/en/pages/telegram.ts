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
  bucketTitle: 'Message batches',
  bucketDescription: 'Saving applies from the next batch. A batch that is already collecting keeps its timing.',
  bucketFields: {
    window: {
      label: 'Minimum wait (seconds)',
      help: 'A batch collects for at least this long.',
    },
    max: {
      label: 'Maximum wait (seconds)',
      help: 'Counted from the first message of the batch. Extensions never go past it.',
    },
    bump: {
      label: 'Extension per message (seconds)',
      help: 'Each new message keeps the batch collecting at least this long after it arrives. 0 means no extension.',
    },
  },
  bucketMaxFollowsWindow: 'Same as the minimum wait',
  bucketErrors: {
    integer: 'Enter a whole number of seconds',
    range: 'Must be at most {{max}}',
    belowWindow: 'Must be at least the minimum wait',
  },
  bucketRunning: 'Running: {{value}}',
  bucketUnchanged: 'No unsaved changes',
  bucketPending_one: '{{count}} unsaved change',
  bucketPending_other: '{{count}} unsaved changes',
  bucketInvalid: 'Fix the highlighted fields before saving.',
  bucketSave: 'Save and apply',
  bucketDiscard: 'Discard changes',
};
