export const roles = {
  pageDescription: 'اختر النموذج لكل مهمة من مهام البوت وحدّد مقدار تفكيره. تسري التغييرات المحفوظة فورًا.',
  form: {
    pending_zero: 'لا تغييرات غير محفوظة',
    pending_one: 'تغيير واحد غير محفوظ',
    pending_two: 'تغييران غير محفوظين',
    pending_few: '{{count}} تغييرات غير محفوظة',
    pending_many: '{{count}} تغييرًا غير محفوظ',
    pending_other: '{{count}} تغيير غير محفوظ',
    unchanged: 'لا تغييرات غير محفوظة',
    saved: 'كل التغييرات محفوظة',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    discard: 'تجاهل التغييرات',
    partial: 'حُفظ جزئيًا. {{message}} بقية تغييراتك ما زالت هنا.',
    refreshFailed:
      'أُرسلت تغييراتك، لكن الصفحة تعذّرت عليها إعادة تحميل الإعدادات: {{message}} أعد تحميل الصفحة قبل الحفظ مرة أخرى.',
    missingModel: 'لم يبقَ {{model}} مُعدًّا. اختر نموذجًا آخر واحفظ مرة أخرى.',
    cardChanged: 'تغييرات غير محفوظة',
  },
  manageProviders: 'إدارة المزوّدين',
  addProvider: 'إضافة مزوّد',
  noProvidersTitle: 'لا مزوّدين بعد',
  noProvidersDescription: 'أضف مزوّدًا والنماذج التي تريدها في صفحة «المزوّدون»، ثم عُد لتسند إليها مهامًا.',
  modelLabel: 'النموذج',
  thinkingLabel: 'جهد التفكير',
  levelUnset: 'غير معيّن',
  unset: 'غير معيّن',
  notReasoning: 'لا جهد تفكير في هذا النموذج يمكن تعديله',
  searchModels: 'بحث في النماذج',
  noMatchingModels: 'لا نموذج يطابق هذا البحث.',
  useAs: 'استخدام كـ',
  useAsAria: 'استخدام {{model}} كـ',
  agent: {
    title: 'نموذج الوكيل',
    short: 'الوكيل',
    description: 'النموذج الرئيسي الذي يقرأ المحادثات ويقرر طريقة الرد. بدونه لا يردّ البوت.',
    resetsNote: 'يعود إلى أضعف مستوى عند تغيير النموذج',
  },
  vision: {
    title: 'نموذج الرؤية',
    short: 'الرؤية',
    description: 'يصف الصور والملصقات: قراءة الصور وفهرسة الملصقات تعتمدان عليه. بدونه يصبح كلاهما غير متاح.',
  },
  tool: {
    title: 'نموذج الأدوات',
    short: 'الأدوات',
    description: 'ينفّذ المهام الخلفية مثل دمج القواميس وذاكرة المجموعة. يتبع نموذج الوكيل ما لم يُعيَّن.',
    defaultGroup: 'الافتراضي',
    inherit: 'وراثة نموذج الوكيل',
    levelInherited: 'يتبع نموذج الوكيل',
  },
};

export const kind = {
  builtin: 'مدمج',
  custom: 'مخصص',
};

export const apiFormat = {
  openaiCompletions: 'OpenAI (Chat Completions)',
  openaiResponses: 'OpenAI (Responses)',
  anthropicMessages: 'Anthropic',
  googleGenerativeAi: 'Google',
};

export const modality = {
  text: 'نص',
  image: 'صورة',
};

export const toolModel = {
  savedInherited: 'نموذج الأدوات يتبع الآن نموذج الوكيل',
  saved: 'غُيّر نموذج الأدوات؛ جهد التفكير هو {{level}}',
  conflict: 'تغيّرت الإعدادات في مكان آخر أثناء التعديل. حُدّثت الصفحة؛ اختر مرة أخرى.',
};
