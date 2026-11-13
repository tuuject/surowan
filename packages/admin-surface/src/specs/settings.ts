import type { EndpointSpec } from '../types.ts';

/**
 * Telegram settings page. The token is write-only: the response only reports
 * whether one is configured. The bucket timing is hot-applied, and a batch
 * already collecting keeps the timing it opened with.
 */
export const TELEGRAM_SPECS: readonly EndpointSpec[] = [
  {
    command: 'telegram show',
    method: 'GET',
    path: 'telegram',
    summary: 'Show the live connection status, whether a token is configured, and the saved and running bucket timing',
  },
  {
    command: 'telegram bucket-timing',
    method: 'PUT',
    path: 'telegram/bucket-timing',
    body: true,
    revision: 'config',
    summary:
      'Save and hot-apply bucket_window_seconds, bucket_max_seconds and bucket_bump_seconds; null removes an optional field',
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

/**
 * Telegram → Sticker sets: the `telegram.sticker_sets` list, hot-applied. A
 * set's Telegram name is fixed once added; only its alias and note change.
 * Adding or removing a set stops running Telegram invocations.
 */
export const STICKER_SET_SPECS: readonly EndpointSpec[] = [
  {
    command: 'sticker-set list',
    method: 'GET',
    path: 'sticker-sets',
    summary: 'List sticker sets with their notes and index progress',
  },
  {
    command: 'sticker-set add',
    method: 'POST',
    path: 'sticker-sets',
    body: true,
    revision: 'config',
    summary: 'Add a Telegram sticker set by name or link, with an alias and an optional note',
  },
  {
    command: 'sticker-set update',
    method: 'PUT',
    path: 'sticker-sets/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    body: true,
    revision: 'config',
    summary: 'Rename a sticker set alias or edit its note; the Telegram set stays the same',
  },
  {
    command: 'sticker-set remove',
    method: 'DELETE',
    path: 'sticker-sets/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Remove a sticker set; its index is kept for a later re-add',
  },
];

/** Warnings page: standing warnings are derived, event warnings are stored. */
export const WARNING_SPECS: readonly EndpointSpec[] = [
  {
    command: 'warning list',
    method: 'GET',
    path: 'warnings',
    params: ['limit', 'offset', 'as-of=as_of', 'unread'],
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
