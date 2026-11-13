import type { admins as adminsEn } from '../../en/pages/admins.ts';

/** Mirrors `en/pages/admins.ts` key for key; the annotation fails the build on drift. */
export const admins: typeof adminsEn = {
  adminAdded: '机器人管理员已添加',
  adminRemoved: '机器人管理员已移除',
  colTelegramUserId: 'Telegram 用户 ID',
  colActions: '操作',
  invalidUserId: '请输入 1–15 位数字的 Telegram 用户 ID。',
  addAdmin: '添加机器人管理员',
  loadingAdmins: '正在加载机器人管理员…',
  emptyAdmins: '还没有机器人管理员。',
  addTitle: '添加机器人管理员',
  addDescription: '输入要管理机器人的账号的 Telegram 用户 ID。',
  userIdLabel: 'Telegram 用户 ID',
  userIdPlaceholder: '例如 123456789',
  adding: '添加中…',
  add: '添加',
  remove: '移除',
  removeTitle: '移除管理员 {{id}}？',
  removeDescription: '该用户将无法再使用机器人命令，立即生效。',
  removeConfirm: '移除管理员',
};
