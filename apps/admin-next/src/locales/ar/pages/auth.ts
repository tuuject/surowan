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
  setupTitle: 'إنشاء حساب المشرف',
  setupDescription: 'أول تشغيل. اختر اسم مستخدم وكلمة مرور من 12 حرفًا على الأقل.',
  passwordMinLength: '12 حرفًا على الأقل',
  createAccount: 'إنشاء الحساب',
  creating: 'جارٍ الإنشاء…',
  passkeySignIn: 'تسجيل الدخول بمفتاح مرور',
  passkeySigningIn: 'بانتظار مفتاح المرور…',
  passkeyUnavailable:
    'تسجيل الدخول بمفتاح المرور غير متاح هنا. افتح اللوحة عبر HTTPS في متصفح يدعم مفاتيح المرور، أو سجّل الدخول بكلمة المرور.',
};
