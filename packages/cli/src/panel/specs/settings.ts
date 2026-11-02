import type { EndpointSpec } from '../types.ts';

/**
 * Telegram settings page. The token is write-only: the response only reports
 * whether one is configured.
 */
export const TELEGRAM_SPECS: readonly EndpointSpec[] = [
  {
    command: 'telegram show',
    method: 'GET',
    path: 'telegram',
    summary: 'Show the live connection status and whether a token is configured',
  },
  {
    command: 'telegram token',
    method: 'PUT',
    path: 'telegram',
    body: true,
    revision: 'config',
    nullClearedBy: { token: 'telegram token clear' },
    summary: 'Save a new Bot Token into the key jar',
  },
  {
    command: 'telegram token clear',
    method: 'PUT',
    path: 'telegram',
    fixedBody: { token: null },
    revision: 'config',
    confirm: 'destructive',
    summary: 'Delete the Bot Token and recycle the jar entry it referenced',
  },
];

/** Warnings page: standing warnings are derived, event warnings are stored. */
export const WARNING_SPECS: readonly EndpointSpec[] = [
  {
    command: 'warning list',
    method: 'GET',
    path: 'warnings',
    params: ['limit', 'cursor', 'unread'],
    summary: 'List standing and event warnings with the unread count',
  },
  {
    command: 'warning read',
    method: 'POST',
    path: 'warnings/:id/read',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Mark one event warning as read',
  },
  {
    command: 'warning clear',
    method: 'DELETE',
    path: 'warnings',
    confirm: 'destructive',
    summary: 'Delete every stored event warning',
  },
];

/** Manage → Bot admins: the `telegram.admins` whitelist. */
export const ADMIN_SPECS: readonly EndpointSpec[] = [
  {
    command: 'bot-admin list',
    method: 'GET',
    path: 'admins',
    summary: 'List the Telegram users allowed to run Bot admin commands',
  },
  {
    command: 'bot-admin add',
    method: 'POST',
    path: 'admins',
    body: true,
    revision: 'config',
    summary: 'Add a Telegram user to the Bot admin whitelist',
  },
  {
    command: 'bot-admin remove',
    method: 'DELETE',
    path: 'admins/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Remove a Telegram user from the Bot admin whitelist',
  },
];
