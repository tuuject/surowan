import type { CompleteCatalog } from '../../catalog.ts';
import type { admins as adminsEn } from '../../en/pages/admins.ts';

/** Mirrors `en/pages/admins.ts` key for key. */
export const admins: CompleteCatalog<typeof adminsEn> = {
  adminAdded: 'أُضيف مشرف البوت',
  adminRemoved: 'أُزيل مشرف البوت',
  colTelegramUserId: 'معرّف مستخدم Telegram',
  colActions: 'الإجراءات',
  invalidUserId: 'أدخل معرّف مستخدم Telegram من 1 إلى 15 رقمًا.',
  addAdmin: 'إضافة مشرف بوت',
  loadingAdmins: 'جارٍ تحميل مشرفي البوت…',
  emptyAdmins: 'لا يوجد مشرفو بوت مُعدّون.',
  addTitle: 'إضافة مشرف بوت',
  addDescription: 'أدخل معرّف مستخدم Telegram الرقمي للحساب الذي يجب أن يتحكم بالبوت.',
  userIdLabel: 'معرّف مستخدم Telegram',
  userIdPlaceholder: 'مثال: 123456789',
  adding: 'جارٍ الإضافة…',
  add: 'إضافة',
  remove: 'إزالة',
  removeTitle: 'إزالة المشرف {{id}}؟',
  removeDescription: 'لن يتمكن بعد الآن من تنفيذ أوامر البوت. يسري هذا فورًا.',
  removeConfirm: 'إزالة المشرف',
};
