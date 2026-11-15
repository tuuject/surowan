import type { Catalog } from '../../catalog.ts';
import type { auth as authEn } from '../../en/pages/auth.ts';

/** Mirrors `en/pages/auth.ts` key for key. */
export const auth: Catalog<typeof authEn> = {
  loginDescription: 'Zum Fortfahren die Zugangsdaten eingeben.',
  username: 'Benutzername',
  password: 'Passwort',
  usernameRequired: 'Benutzername erforderlich',
  usernamePattern: '3–32 Buchstaben, Ziffern, Punkte, Unterstriche oder Bindestriche',
  passwordRequired: 'Passwort erforderlich',
  signIn: 'Anmelden',
  signingIn: 'Anmeldung läuft…',
  setupTitle: 'Administratorkonto anlegen',
  setupDescription: 'Erster Start. Benutzername und ein Passwort mit mindestens 12 Zeichen wählen.',
  passwordMinLength: 'Mindestens 12 Zeichen',
  createAccount: 'Konto erstellen',
  creating: 'Wird erstellt…',
  passkeySignIn: 'Mit einem Passkey anmelden',
  passkeySigningIn: 'Warten auf Passkey…',
  passkeyUnavailable:
    'Passkey-Anmeldung ist hier nicht verfügbar. Das Panel über HTTPS in einem Browser mit Passkey-Unterstützung öffnen oder sich mit dem Passwort anmelden.',
  codeSignIn: 'Mit einem Einmalcode anmelden',
  codeDescription: 'Den auf dem Server erzeugten Einmalcode einfügen.',
  code: 'Einmalcode',
  codeHelp: 'Auf dem Server mit dem Befehl <command>pairing create --web</command> erzeugen.',
  codeRequired: 'Einmalcode einfügen',
  codePattern: 'Den Code vollständig so kopieren, wie der Server ihn ausgegeben hat',
  passwordSignIn: 'Mit Passwort anmelden',
};
