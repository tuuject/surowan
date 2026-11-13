import type { auth as authEn } from '../../en/pages/auth.ts';

/** Mirrors `en/pages/auth.ts` key for key; the annotation fails the build on drift. */
export const auth: typeof authEn = {
  loginDescription: '输入凭据以继续。',
  username: '用户名',
  password: '密码',
  usernameRequired: '用户名不能为空',
  usernamePattern: '3–32 个字母、数字、点、下划线或连字符',
  passwordRequired: '密码不能为空',
  signIn: '登录',
  signingIn: '登录中…',
  setupTitle: '创建管理员账户',
  setupDescription: '首次运行，请设置用户名和至少 12 个字符的密码。',
  passwordMinLength: '至少 12 个字符',
  createAccount: '创建账户',
  creating: '创建中…',
  passkeySignIn: '使用通行密钥登录',
  passkeySigningIn: '正在等待通行密钥…',
  passkeyUnavailable: '这里无法使用通行密钥登录。请在支持通行密钥的浏览器中通过 HTTPS 打开面板，或改用密码登录。',
};
