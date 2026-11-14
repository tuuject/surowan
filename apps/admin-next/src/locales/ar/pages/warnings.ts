import type { CompleteCatalog } from '../../catalog.ts';
import type { warnings as warningsEn } from '../../en/pages/warnings.ts';

/** Mirrors `en/pages/warnings.ts` key for key. */
export const warnings: CompleteCatalog<typeof warningsEn> = {
  pageDescription: 'تحذيرات صحة النظام التي تحتاج إلى انتباه، وسجل تحذيرات الأحداث.',
  standingTitle: 'التحذيرات المستمرة',
  eventsTitle: 'تحذيرات الأحداث',
  unreadCount: '{{count, number}} غير مقروء',
  unreadCount_zero: 'لا شيء غير مقروء',
  unreadCount_one: 'واحد غير مقروء',
  unreadCount_two: 'اثنان غير مقروءين',
  unreadCount_few: '{{count, number}} غير مقروءة',
  unreadCount_many: '{{count, number}} غير مقروء',
  unreadCount_other: '{{count, number}} غير مقروء',
  unread: 'غير مقروء',
  standing: 'مستمر',
  markRead: 'تحديد كمقروء',
  markedRead: 'حُدّد التحذير كمقروء',
  clearHistory: 'مسح سجل التحذيرات',
  clearTitle: 'مسح كل تحذيرات الأحداث؟',
  clearDescription:
    'تُحذف كل تحذيرات الأحداث، المقروءة وغير المقروءة. تبقى التحذيرات المستمرة ما دامت شروطها قائمة. لا يمكن التراجع عن هذا.',
  clearConfirm: 'مسح التحذيرات',
  cleared: 'مُسح {{count, number}} تحذير',
  cleared_zero: 'لم تُمسح أي تحذيرات',
  cleared_one: 'مُسح تحذير واحد',
  cleared_two: 'مُسح تحذيران',
  cleared_few: 'مُسحت {{count, number}} تحذيرات',
  cleared_many: 'مُسح {{count, number}} تحذيرًا',
  cleared_other: 'مُسح {{count, number}} تحذير',
  loadFailed: 'تعذّر تحميل التحذيرات',
  noStanding: 'لا تحذيرات مستمرة.',
  noEvents: 'لا تحذيرات أحداث بعد.',
  missingFields: 'مفقود: {{fields}}',
  invalidApiKeys: 'مفاتيح غير صالحة: {{keys}}',
  lastFailedAt: 'آخر إخفاق: <time>{{time}}</time>',
  createdAt: 'أُنشئ <time>{{time}}</time>',
  updatedAt: 'حُدّث <time>{{time}}</time>',
  readAt: 'قُرئ <time>{{time}}</time>',
  severity: {
    warning: 'تحذير',
    critical: 'حرج',
  },
  actions: {
    openDeveloper: 'فتح المطوّر',
    openModels: 'فتح النماذج',
    openInvocations: 'فتح الاستدعاءات',
    openSettings: 'فتح الإعدادات',
    openTelegram: 'فتح إعدادات Telegram',
    openApiKeys: 'فتح مفاتيح API',
  },
  codes: {
    developer_payload_recording: {
      title: 'يجري تسجيل الحمولات الخام للطلبات',
      body: 'تسجيل التطوير مفعّل، لذا تُخزَّن لقطات طلبات النموذج واستجاباته في قاعدة البيانات. أوقفه من صفحة «المطوّر» عندما لا تعود بحاجة إليه.',
    },
    agent_model_missing: {
      title: 'لا نموذج وكيل مُعدّ',
      body: 'يستقبل البوت الرسائل لكنه لا يستطيع بدء أي استدعاء حتى يُعيَّن مزوّد الوكيل العام والنموذج ومستوى التفكير.',
    },
    vision_model_missing: {
      title: 'لا نموذج رؤية مُعدّ',
      body: 'فهم الصور وفهرسة الملصقات في الخلفية غير متاحين حتى يُعيَّن مزوّد الرؤية ونموذجها.',
    },
    invocation_failure_rate: {
      title: 'معدل فشل الاستدعاءات أعلى من الحد',
      body: 'فشل {{failed}} من آخر {{total}} استدعاء مكتمل ({{rate}}%)، وهو أعلى من حد {{threshold}}%.',
    },
    admin_login_failures: {
      title: 'إخفاقات متتالية في تسجيل دخول المشرفين',
      body: 'رصدت اللوحة {{count}} إخفاقًا متتاليًا في اسم المستخدم أو كلمة المرور.',
      body_zero: 'لم ترصد اللوحة أي إخفاق متتالٍ في اسم المستخدم أو كلمة المرور.',
      body_one: 'رصدت اللوحة إخفاقًا واحدًا متتاليًا في اسم المستخدم أو كلمة المرور.',
      body_two: 'رصدت اللوحة إخفاقين متتاليين في اسم المستخدم أو كلمة المرور.',
      body_few: 'رصدت اللوحة {{count}} إخفاقات متتالية في اسم المستخدم أو كلمة المرور.',
      body_many: 'رصدت اللوحة {{count}} إخفاقًا متتاليًا في اسم المستخدم أو كلمة المرور.',
      body_other: 'رصدت اللوحة {{count}} إخفاق متتالٍ في اسم المستخدم أو كلمة المرور.',
    },
    telegram_network_error: {
      title: 'تعذّر الاتصال بخادم Telegram',
      body: 'يواصل البوت المحاولة. سيعيد الاتصال تلقائيًا بمجرد أن يصبح Telegram متاحًا.',
    },
    telegram_config_error: {
      title: 'خطأ في إعدادات Telegram',
      unauthorized: 'أُلغي رمز Telegram أو أنه غير صالح',
      conflict: 'رمز Telegram هذا قيد الاستخدام من برنامج آخر',
      token_unreadable: 'تعذّرت قراءة رمز Telegram',
      body: {
        unknown: 'لا يستطيع Telegram البدء بإعدادات الرمز الحالية.',
        unauthorized: 'استبدل رمز البوت في صفحة Telegram برمز صالح من @BotFather.',
        conflict: 'ثمة عملية أخرى تستقصي بهذا الرمز. أوقفها أو اضبط رمزًا مختلفًا.',
        token_unreadable:
          'تعذّرت قراءة مصدر الرمز المُعدّ. تحقق من الرمز المحفوظ أو متغيّر البيئة أو الأمر الذي يشير إليه.',
      },
    },
    api_key_invalid_permissions: {
      title: 'مفاتيح API بصلاحيات غير صالحة',
      body: 'مفتاح API واحد أو أكثر لديه صلاحيات غير صالحة ولا يمكنه تسجيل الدخول. احفظ وضعًا لكل منها في صفحة مفاتيح API.',
    },
    unknown: {
      title: 'تحذير غير معروف: {{code}}',
      body: 'لا يوجد قالب لهذا الرمز في إصدار اللوحة هذا؛ المتغيّرات الخام تليها.',
    },
  },
};
