/**
 * Pages `admins` group. English is the source catalog; `zh-CN/pages/admins.ts`
 * mirrors it key for key.
 */
export const admins = {
  adminAdded: 'Bot admin added',
  adminRemoved: 'Bot admin removed',
  colTelegramUserId: 'Telegram user ID',
  colActions: 'Actions',
  invalidUserId: 'Numeric Telegram user ID (1-15 digits)',
  alertTitle: 'Telegram bot admins',
  alertDesc1: 'These Telegram users may run',
  alertDesc2: 'and',
  alertDesc3:
    'in allowed chats. They are bot administrators, unrelated to the admin panel login account. The user ID is the numeric Telegram account ID (see',
  alertDesc4: '). The whitelist is the',
  alertDesc5: 'field in config.jsonc; adding or removing here writes the file and hot-applies without a restart.',
  addAdmin: 'Add bot admin',
  loadingAdmins: 'Loading bot admins…',
  emptyAdmins: 'No bot admins configured.',
  addTitle: 'Add bot admin',
  addDescription: 'Enter the numeric Telegram user ID of the account that should control the bot.',
  userIdLabel: 'Telegram user ID',
  userIdPlaceholder: 'e.g. 123456789',
  adding: 'Adding…',
  add: 'Add',
  remove: 'Remove',
  removeTitle: 'Remove admin {{id}}?',
  removeDescription:
    'The user will no longer be able to run bot commands; the change is written to config.jsonc and applies immediately.',
  removeConfirm: 'Remove admin',
};
