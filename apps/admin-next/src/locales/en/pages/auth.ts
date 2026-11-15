/**
 * Pages `auth` group. English is the source catalog; `zh-CN/pages/auth.ts`
 * mirrors it key for key.
 */
export const auth = {
  loginDescription: 'Enter your credentials to continue.',
  username: 'Username',
  password: 'Password',
  usernameRequired: 'Username is required',
  usernamePattern: '3–32 letters, digits, dots, underscores or hyphens',
  passwordRequired: 'Password is required',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  setupTitle: 'Create the administrator account',
  setupDescription: 'First run. Choose a username and a password of at least 12 characters.',
  passwordMinLength: 'At least 12 characters',
  createAccount: 'Create account',
  creating: 'Creating…',
  passkeySignIn: 'Sign in with a passkey',
  passkeySigningIn: 'Waiting for passkey…',
  passkeyUnavailable:
    'Passkey sign-in is unavailable here. Open the panel over HTTPS in a browser that supports passkeys, or sign in with your password.',
  codeSignIn: 'Sign in with a one-time code',
  codeDescription: 'Paste the one-time code generated on the server.',
  code: 'One-time code',
  codeHelp: 'Run the <command>pairing create --web</command> command on the server to get one.',
  codeHelpDocker: 'On the server, run this in the folder that holds <file>docker-compose.yml</file>:',
  copyCommand: 'Copy command',
  copyCommandFailed: 'Copy failed. Select the command and copy it manually.',
  codeRequired: 'Paste the one-time code',
  codePattern: 'Copy the whole code exactly as the server printed it',
  passwordSignIn: 'Sign in with a password',
};
