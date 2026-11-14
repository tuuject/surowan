import type { Catalog } from '../../catalog.ts';
import type { passkeys as passkeysEn } from '../../en/pages/passkeys.ts';

/** Mirrors `en/pages/passkeys.ts` key for key. */
export const passkeys: Catalog<typeof passkeysEn> = {
  title: 'Passkeys',
  description: 'Mit dem Passkey eines Geräts statt mit einem Passwort anmelden.',
  add: 'Passkey hinzufügen',
  name: 'Name',
  created: 'Erstellt',
  lastUsed: 'Zuletzt verwendet',
  neverUsed: 'Nie verwendet',
  unusable: 'Für eine andere Panel-URL registriert; zur Anmeldung hier nicht mehr verwendbar.',
  actions: 'Aktionen',
  delete: 'Löschen',
  empty: 'Noch keine Passkeys registriert.',
  deleteTitle: 'Passkey „{{name}}“ löschen?',
  deleteDescription:
    'Dieser Passkey funktioniert sofort nicht mehr und lässt sich nicht wiederherstellen. Ein neuer kann jederzeit registriert werden.',
  deleteConfirm: 'Passkey löschen',
  deleted: 'Passkey gelöscht',
  deleteLastDisabled: 'Dies ist die letzte Anmeldemethode. Zuerst oben ein Passwort setzen, bevor er gelöscht wird.',
  noPasswordHint:
    'Es ist kein Passwort gesetzt. Zuerst über die Karte „Admin-Zugangsdaten“ oben eines hinzufügen, bevor der letzte Passkey gelöscht wird.',
  passwordStatus: 'Passwort',
  passwordSet: 'gesetzt',
  passwordNotSet: 'nicht gesetzt',
  passwordDelete: 'Passwort löschen',
  passwordDeleteTitle: 'Eigenes Passwort löschen?',
  passwordDeleteDescription:
    'Danach sind Passkeys die einzige Anmeldemethode. Die aktuelle Sitzung bleibt bis zur Abmeldung aktiv.',
  passwordDeleteConfirm: 'Passwort löschen',
  passwordDeleted: 'Passwort gelöscht',
  unsupported:
    'Passkeys sind hier nicht verfügbar. Das Panel über HTTPS in einem Browser mit Passkey-Unterstützung öffnen, um einen hinzuzufügen. Bestehende Passkeys lassen sich weiterhin unten verwalten.',
  cancelled: 'Passkey-Anfrage abgebrochen',
  discoverableRequired:
    'Dieser Browser kann keine Passkeys speichern. Anderen Browser oder ein anderes Gerät versuchen.',
  webauthnFailed: 'Die Passkey-Anfrage ist fehlgeschlagen. Erneut versuchen.',
  registerTitle: 'Passkey hinzufügen',
  registerDescription:
    'Diesen Passkey benennen und dann mit der Bildschirmsperre, dem Fingerabdruck oder einer anderen Prüfung des Geräts bestätigen.',
  nameLabel: 'Name des Passkeys',
  namePlaceholder: 'z. B. Arbeitslaptop',
  invalidName: 'Einen Namen mit 1–80 Zeichen eingeben.',
  registerConfirm: 'Passkey registrieren',
  registering: 'Wird registriert…',
  registered: 'Passkey registriert',
};
