import type { CompleteCatalog } from '../../catalog.ts';
import type { auth as authEn } from '../../en/pages/auth.ts';

/** Mirrors `en/pages/auth.ts` key for key. */
export const auth: CompleteCatalog<typeof authEn> = {
  loginDescription: 'أدخل بيانات الاعتماد للمتابعة.',
  username: 'اسم المستخدم',
  password: 'كلمة المرور',
  usernameRequired: 'اسم المستخدم مطلوب',
  usernamePattern: 'من 3 إلى 32 حرفًا أو رقمًا أو نقطة أو شرطة سفلية أو شرطة',
  passwordRequired: 'كلمة المرور مطلوبة',
  signIn: 'تسجيل الدخول',
  signingIn: 'جارٍ تسجيل الدخول…',
  passkeySignIn: 'تسجيل الدخول بمفتاح مرور',
  passkeySigningIn: 'بانتظار مفتاح المرور…',
  passkeyUnavailable:
    'تسجيل الدخول بمفتاح المرور غير متاح هنا. افتح اللوحة عبر HTTPS في متصفح يدعم مفاتيح المرور، أو سجّل الدخول بكلمة المرور.',
  codeSignIn: 'تسجيل الدخول برمز لمرة واحدة',
  codeDescription: 'الصق الرمز لمرة واحدة الذي أُنشئ على الخادم.',
  code: 'رمز لمرة واحدة',
  codeHelp: 'شغّل الأمر <command>pairing create --web</command> على الخادم للحصول عليه.',
  codeHelpDocker: 'على الخادم، شغّل هذا الأمر في المجلد الذي يحتوي على <file>docker-compose.yml</file>:',
  copyCommand: 'نسخ الأمر',
  copyCommandFailed: 'تعذّر النسخ. حدّد الأمر وانسخه يدويًا.',
  codeRequired: 'الصق الرمز لمرة واحدة',
  codePattern: 'انسخ الرمز كاملًا كما طبعه الخادم',
  passwordSignIn: 'تسجيل الدخول بكلمة المرور',
};
