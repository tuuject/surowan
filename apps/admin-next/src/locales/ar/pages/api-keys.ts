import type { CompleteCatalog } from '../../catalog.ts';
import type { apiKeys as apiKeysEn } from '../../en/pages/api-keys.ts';

/** Mirrors `en/pages/api-keys.ts` key for key. */
export const apiKeys: CompleteCatalog<typeof apiKeysEn> = {
  title: 'مفاتيح API',
  create: 'إنشاء مفتاح API',
  name: 'الاسم',
  prefix: 'البادئة',
  mode: 'الوضع',
  modes: {
    read: 'قراءة فقط',
    read_write: 'قراءة + كتابة',
    read_paid: 'قراءة + عمليات مدفوعة',
    all: 'الكل',
  },
  modeHints: {
    read: 'قراءة كل سجلات التدقيق والإعدادات وإصدارات التوجيهات. لا تغييرات ولا عمليات تُحتسب عليها تكلفة.',
    read_write:
      'قراءة وتغيير الإعدادات والمحادثات والتوجيهات والمذكرات والقواميس وذاكرة المجموعة والتحذيرات ومدخلات الملعب. لا عمليات مدفوعة.',
    read_paid:
      'قراءة وتنفيذ العمليات المدفوعة مثل إعادة التشغيل وفحوص الحالة وتوليد الصور ومعاينة دمج القاموس. لا تغييرات في الإعدادات أو الحالة.',
    all: 'قراءة وكتابة وتنفيذ العمليات المدفوعة. إفراج الملعب يحتاج إلى الكتابة والعمليات المدفوعة معًا.',
  },
  invalidPermissions: 'صلاحيات غير صالحة',
  invalidPermissionsHint: 'لهذا المفتاح صلاحيات غير صالحة ولا يمكنه تسجيل الدخول. احفظ وضعًا لإصلاحه.',
  created: 'أُنشئ',
  lastUsed: 'آخر استخدام',
  status: 'الحالة',
  actions: 'الإجراءات',
  active: 'نشط',
  revoked: 'ملغى',
  neverUsed: 'لم يُستخدم',
  empty: 'لم تُنشأ أي مفاتيح API بعد.',
  createDescription: 'اختر اسمًا ووضع صلاحيات. استخدم من 1 إلى 80 حرفًا للاسم.',
  namePlaceholder: 'مثال: CLI للحاسوب المحمول',
  invalidName: 'أدخل اسمًا من 1 إلى 80 حرفًا.',
  createConfirm: 'إنشاء المفتاح',
  creating: 'جارٍ الإنشاء…',
  saveTitle: 'احفظ مفتاح API الآن',
  saveDescription:
    'يُعرض هذا المفتاح مرة واحدة فقط. انسخه إلى مدير كلمات المرور أو متغيّر بيئة آمن قبل الإغلاق. لا يمكن استرجاعه بعد إغلاق هذه الصفحة أو مغادرتها أو إعادة تحميلها.',
  keyLabel: 'مفتاح API',
  copy: 'نسخ مفتاح API',
  copyFailed: 'تعذّر النسخ. حدّد المفتاح وانسخه يدويًا.',
  done: 'تم',
  editMode: 'تغيير الوضع',
  editModeDescription: 'تغيير وضع الصلاحيات للمفتاح «{{name}}». لا يتغيّر قيمة المفتاح.',
  modeUpdated: 'حُدّث وضع مفتاح API',
  rotate: 'تجديد',
  rotateTitle: 'تجديد مفتاح API؟',
  rotateDescription: 'إصدار قيمة جديدة للمفتاح «{{name}}»؟ تتوقف القيمة القديمة فورًا؛ يبقى الاسم والوضع كما هما.',
  rotateConfirm: 'تجديد المفتاح',
  revoke: 'إلغاء',
  revokeTitle: 'إلغاء مفتاح API؟',
  revokeDescription: 'إلغاء المفتاح «{{name}}»؟ سيتوقف فورًا ولا يمكن استرجاعه. ستبقى بياناته الوصفية في القائمة.',
  revokeConfirm: 'إلغاء المفتاح',
  revokedMessage: 'أُلغي مفتاح API',
};
