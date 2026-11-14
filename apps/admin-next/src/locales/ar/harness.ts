import type { CompleteCatalog } from '../catalog.ts';
import type { harness as harnessEn } from '../en/harness.ts';

/** Mirrors `en/harness.ts` key for key; plural keys add the CLDR Arabic categories. */
export const harness: CompleteCatalog<typeof harnessEn> = {
  loadFailed: 'تعذّر تحميل إعدادات التشغيل',
  save: 'حفظ وتطبيق',
  saving: 'جارٍ الحفظ…',
  discard: 'تجاهل التغييرات',
  unchanged: 'لا تغييرات غير محفوظة',
  pending_zero: 'لا تغييرات غير محفوظة',
  pending_one: 'تغيير واحد غير محفوظ',
  pending_two: 'تغييران غير محفوظين',
  pending_few: '{{count}} تغييرات غير محفوظة',
  pending_many: '{{count}} تغييرًا غير محفوظ',
  pending_other: '{{count}} تغيير غير محفوظ',
  invalid: 'أصلح الحقول المميّزة قبل الحفظ.',
  running: 'قيد التشغيل: {{value}}',
  noLimit: 'بلا حد',
  noLimitPlaceholder: 'الفراغ يعني بلا حد',
  on: 'تشغيل',
  off: 'إيقاف',
  sections: {
    navigation: 'أقسام النموذج',
    jump: 'الانتقال إلى القسم',
    invalid: '، يحتاج إلى تصحيح',
    changed: '، تغييرات غير محفوظة',
  },
  errors: {
    integer: 'أدخل عددًا صحيحًا',
    number: 'أدخل عددًا',
    min: 'يجب ألا يقل عن {{min}}',
    max: 'يجب ألا يتجاوز {{max}}',
    greaterThan: 'يجب أن يكون أكبر من {{min}}',
    lines: 'أدخل سطرًا واحدًا على الأقل',
    option: 'اختر أحد الخيارات المدرجة',
  },
  groups: {
    budget: {
      title: 'الميزانية والتزامن',
    },
    send: {
      title: 'سلوك الإرسال',
    },
    rateLimits: {
      title: 'حدود المعدل',
    },
    context: {
      title: 'السياق',
    },
    proactiveReply: {
      title: 'الردود الاستباقية',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: 'ميزانية الرموز اليومية',
      description: 'حد أقصى يومي للرموز، مشترك بين الردود وقراءة الصور. تقليله يسري من استدعاء النموذج التالي.',
    },
    max_concurrency: {
      label: 'أقصى عدد استدعاءات متزامنة',
      description: 'كم عدد الاستدعاءات التي يجوز أن تعمل في الوقت نفسه.',
    },
    history_messages: {
      label: 'رسائل السجل',
      description: 'كم عدد الرسائل السابقة التي يجلبها كل استدعاء جديد.',
    },
    context_stop_ratio: {
      label: 'نسبة إيقاف السياق',
      description: 'عندما تبلغ المدخلات هذه النسبة من طول سياق النموذج، يرد التشغيل مرة أخيرة ثم ينتهي.',
    },
    send_max_text_length: {
      label: 'أقصى طول للنص',
      description: 'أطول نص لرسالة واحدة، بالأحرف (1–4096).',
    },
    send_disallow_blank_lines: {
      label: 'منع الأسطر الفارغة',
      description: 'رفض النصوص التي تحتوي أسطرًا فارغة؛ لا تُفصل الفقرات إلا بسطر جديد واحد.',
    },
    send_nudge_enabled: {
      label: 'تذكير الإرسال',
      description: 'تذكير النموذج بالإرسال عندما يكون على وشك التوقف دون إرسال شيء.',
    },
    send_barrier_enabled: {
      label: 'الانتظار لرسائل جديدة',
      description: 'إذا وصلت رسائل جديدة قبل الإرسال، يقرأها النموذج قبل الرد.',
    },
    allow_reply_message_multiple_times: {
      label: 'السماح بردود متعددة على رسالة واحدة',
      description: 'السماح بالرد على الرسالة نفسها أكثر من مرة. تظل الميزانيات وحدود المعدل سارية.',
    },
    send_duplicate_guard_enabled: {
      label: 'حماية من الإرسال المكرر',
      description: 'رفض نص أو ملصق أُرسل بالفعل في الاستدعاء نفسه؛ وإيقاف التشغيل بعد أكثر من 3 عمليات رفض.',
    },
    send_empty_text_strategy: {
      label: 'إرسال بلا نص',
      description: 'ما يحدث عندما يرسل النموذج رسالة نصية دون أي نص.',
      options: {
        reject: 'رفض الاستدعاء',
        silent_success: 'النجاح بصمت (بلا إرسال)',
        random_text: 'إرسال نص بديل عشوائي',
      },
    },
    send_empty_text_fallback_texts: {
      label: 'النصوص البديلة',
      description: 'واحد لكل سطر؛ يُختار أحدها عشوائيًا في كل مرة.',
    },
    'rate_limits.sends_per_window': {
      label: 'عمليات الإرسال لكل نافذة',
      description: 'عدد الرسائل التي يجوز لكل محادثة إرسالها في نافذة واحدة؛ تُحتسب الإرسالات الفاشلة كذلك.',
    },
    'rate_limits.window_seconds': {
      label: 'طول النافذة (ثانية)',
      description: 'النافذة الزمنية التي يغطيها عدد الإرسالات.',
    },
    'rate_limits.turns_per_injection': {
      label: 'الجولات لكل دفعة رسائل',
      description: 'الجولات المسموحة بعد كل دفعة رسائل جديدة قبل أن ينتهي التشغيل.',
    },
    'context.retained_sends_target': {
      label: 'هدف الإرسالات المحتفظ بها',
      description: 'الإرسالات التي تبقى بعد تنظيف السياق؛ يجب أن تكون أقل من الحد الأقصى.',
    },
    'context.retained_sends_max': {
      label: 'الحد الأقصى للإرسالات المحتفظ بها',
      description: 'يُنظّف السياق عندما يحتوي على إرسالات أكثر من هذا الحد.',
    },
    'context.hard_token_ratio': {
      label: 'نسبة التنظيف الإجباري',
      description: 'نسبة من طول سياق النموذج تفرض تنظيفًا؛ يجب ألا تتجاوز نسبة إيقاف السياق.',
    },
    'context.ref_ttl_hours': {
      label: 'مدة صلاحية المراجع (ساعات)',
      description: 'مدة بقاء مراجع الصور والملصقات والردود صالحة. تسري على المراجع الصادرة من الآن.',
    },
    'context.idle_grace_seconds': {
      label: 'مهلة الخمول (ثانية)',
      description:
        'كم ينتظر تشغيل منتهٍ دفعة الرسائل التالية. 0 يعني بلا انتظار؛ وإلا فبمقدار أطول انتظار لدفعة رسائل على الأقل.',
    },
    'context.max_wall_clock_seconds': {
      label: 'أقصى زمن تشغيل (ثانية)',
      description: 'أطول مدة يجوز أن يستغرقها تشغيل واحد؛ يجب أن تتجاوز مهلة الخمول.',
    },
    'context.agent_cache_size': {
      label: 'حجم ذاكرة التخزين المؤقت',
      description: 'كم عدد السياقات التي تبقى مخزنة في الذاكرة. القيمة الأصغر لا تفقد السجل أبدًا.',
    },
    'proactive_reply.enabled': {
      label: 'جدولة الردود الاستباقية',
      description:
        'عند التشغيل: تحصل رسائل المجموعة التي لا تخاطب البوت على فرصة رد فقط إذا نجحت القرعة. عند الإيقاف: تحصل كل دفعة على فرصة. المحادثات الخاصة لا تتأثر أبدًا.',
    },
    'proactive_reply.base_probability': {
      label: 'احتمال المحاولة الأولى',
      description: 'احتمال أول قرعة بعد نجاح، من 0 إلى 1 (0.2 يعني 20%).',
    },
    'proactive_reply.increment': {
      label: 'الزيادة بعد كل إخفاق',
      description: 'تُضاف إلى الاحتمال بعد كل إخفاق، من 0 إلى 1. النجاح يعيدها إلى الصفر.',
    },
    'proactive_reply.hard_pity': {
      label: 'أقصى عدد محاولات',
      description: 'القرعة في هذه المحاولة تنجح دائمًا.',
    },
  },
};
