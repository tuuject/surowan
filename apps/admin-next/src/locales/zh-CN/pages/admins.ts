import type { admins as adminsEn } from '../../en/pages/admins.ts';

/** Mirrors `en/pages/admins.ts` key for key; the annotation fails the build on drift. */
export const admins: typeof adminsEn = {
  adminAdded: 'Bot 管理员已添加',
  adminRemoved: 'Bot 管理员已移除',
  colTelegramUserId: 'Telegram 用户 ID',
  colActions: '操作',
  invalidUserId: '数字 Telegram 用户 ID（1-15 位数字）',
  alertTitle: 'Telegram Bot 管理员',
  alertDesc1: '这些 Telegram 用户可以在允许的会话中执行',
  alertDesc2: '和',
  alertDesc3:
    '。他们是 Bot 管理员，与管理面板的登录账户无关。用户 ID 即数字形式的 Telegram 账户 ID（在允许的会话中向 Bot 发送',
  alertDesc4: '即可查看）。白名单由配置文件中的',
  alertDesc5: ' 字段管理；在这里增删会写回配置文件并立即热应用，无需重启。',
  addAdmin: '添加 Bot 管理员',
  loadingAdmins: '正在加载 Bot 管理员…',
  emptyAdmins: '尚未配置 Bot 管理员。',
  addTitle: '添加 Bot 管理员',
  addDescription: '输入应控制该 Bot 的账户的数字 Telegram 用户 ID。',
  userIdLabel: 'Telegram 用户 ID',
  userIdPlaceholder: '例如 123456789',
  adding: '添加中…',
  add: '添加',
  remove: '移除',
  removeTitle: '移除管理员 {{id}}？',
  removeDescription: '该用户将无法再执行 Bot 命令；变更会写回 config.jsonc 并立即生效。',
  removeConfirm: '移除管理员',
};
