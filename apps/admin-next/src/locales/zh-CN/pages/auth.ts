import type { auth as authEn } from '../../en/pages/auth.ts';

/** Mirrors `en/pages/auth.ts` key for key; the annotation fails the build on drift. */
export const auth: typeof authEn = {
  loginDescription: '输入凭据以继续。',
  username: '用户名',
  password: '密码',
  usernameRequired: '用户名不能为空',
  usernamePattern: '3-32 个字母、数字、点、下划线或连字符',
  passwordRequired: '密码不能为空',
  signIn: '登录',
  signingIn: '登录中…',
  setupTitle: '创建管理员账户',
  setupDescription: '首次运行。请设置用户名和至少 12 个字符的密码。系统仅存储 Argon2id 哈希。',
  passwordMinLength: '至少 12 个字符',
  createAccount: '创建账户',
  creating: '创建中…',
  passkeySignIn: '使用 Passkey 登录',
  passkeySigningIn: '等待 Passkey…',
  passkeyUnavailable:
    '此环境下无法使用 Passkey 登录。请使用支持 WebAuthn 的浏览器并通过 HTTPS（或回环地址）访问，或改用密码登录。',
};
