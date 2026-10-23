/**
 * Pages `auth` group. English is the source catalog; `zh-CN/pages/auth.ts`
 * mirrors it key for key.
 */
export const auth = {
  loginDescription: 'Enter your credentials to continue.',
  username: 'Username',
  password: 'Password',
  usernameRequired: 'Username is required',
  usernamePattern: '3-32 letters, digits, dot, underscore, or hyphen',
  passwordRequired: 'Password is required',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  setupTitle: 'Create the administrator account',
  setupDescription:
    'First run. Choose a username and a password of at least 12 characters. Only an Argon2id hash is stored.',
  passwordMinLength: 'At least 12 characters',
  createAccount: 'Create account',
  creating: 'Creating…',
  passkeySignIn: 'Sign in with a passkey',
  passkeySigningIn: 'Waiting for passkey…',
  passkeyUnavailable:
    'Passkey sign-in is unavailable here. Use a WebAuthn-capable browser over HTTPS (or loopback), or sign in with your password.',
};
