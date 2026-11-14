import type { Catalog } from '../../catalog.ts';
import type { apiKeys as apiKeysEn } from '../../en/pages/api-keys.ts';

/** Mirrors `en/pages/api-keys.ts` key for key. */
export const apiKeys: Catalog<typeof apiKeysEn> = {
  title: 'API-Schlüssel',
  create: 'API-Schlüssel erstellen',
  name: 'Name',
  prefix: 'Präfix',
  mode: 'Modus',
  modes: {
    read: 'Nur Lesen',
    read_write: 'Lesen + Schreiben',
    read_paid: 'Lesen + Kostenpflichtig',
    all: 'Alles',
  },
  modeHints: {
    read: 'Jeden Prüf-, Konfigurations- und Prompt-Stand lesen. Keine Änderungen, keine abgerechneten Aufrufe.',
    read_write:
      'Konfiguration, Chats, Prompts, Notizen, Wörterbuch, Gruppengedächtnis, Warnungen und Playground-Eingaben lesen und ändern. Keine abgerechneten Aufrufe.',
    read_paid:
      'Lesen und abgerechnete Vorgänge ausführen, etwa Wiedergabe, Zustandsprüfungen, Bildgenerierung und Vorschau der Wörterbuch-Zusammenführung. Keine Konfigurations- oder Zustandsänderungen.',
    all: 'Lesen, schreiben und abgerechnete Vorgänge ausführen. Playground-Freigaben benötigen Schreiben und Kostenpflichtig.',
  },
  invalidPermissions: 'Ungültige Berechtigungen',
  invalidPermissionsHint:
    'Dieser Schlüssel hat ungültige Berechtigungen und kann sich nicht anmelden. Einen Modus speichern, um das zu beheben.',
  created: 'Erstellt',
  lastUsed: 'Zuletzt verwendet',
  status: 'Status',
  actions: 'Aktionen',
  active: 'Aktiv',
  revoked: 'Widerrufen',
  neverUsed: 'Nie verwendet',
  empty: 'Noch keine API-Schlüssel erstellt.',
  createDescription: 'Namen und Berechtigungsmodus wählen. Der Name fasst 1–80 Zeichen.',
  namePlaceholder: 'z. B. CLI auf dem Laptop',
  invalidName: 'Einen Namen mit 1–80 Zeichen eingeben.',
  createConfirm: 'Schlüssel erstellen',
  creating: 'Wird erstellt…',
  saveTitle: 'API-Schlüssel jetzt sichern',
  saveDescription:
    'Dieser Schlüssel wird nur einmal angezeigt. Vor dem Schließen in einen Passwortmanager oder eine geschützte Umgebungsvariable kopieren. Nach dem Schließen, Verlassen oder Neuladen dieser Seite lässt er sich nicht wiederherstellen.',
  keyLabel: 'API-Schlüssel',
  copy: 'API-Schlüssel kopieren',
  copyFailed: 'Kopieren nicht möglich. Schlüssel markieren und manuell kopieren.',
  done: 'Fertig',
  editMode: 'Modus ändern',
  editModeDescription: 'Den Berechtigungsmodus für „{{name}}“ ändern. Der Schlüsselwert bleibt gleich.',
  modeUpdated: 'Modus des API-Schlüssels aktualisiert',
  rotate: 'Erneuern',
  rotateTitle: 'API-Schlüssel erneuern?',
  rotateDescription:
    'Einen neuen Wert für „{{name}}“ ausstellen? Der alte Wert funktioniert sofort nicht mehr; Name und Modus bleiben gleich.',
  rotateConfirm: 'Schlüssel erneuern',
  revoke: 'Widerrufen',
  revokeTitle: 'API-Schlüssel widerrufen?',
  revokeDescription:
    '„{{name}}“ widerrufen? Der Schlüssel funktioniert sofort nicht mehr und lässt sich nicht wiederherstellen. Seine Metadaten bleiben in der Liste.',
  revokeConfirm: 'Schlüssel widerrufen',
  revokedMessage: 'API-Schlüssel widerrufen',
};
