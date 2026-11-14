import type { Catalog } from '../../catalog.ts';
import type { telegram as telegramEn } from '../../en/pages/telegram.ts';

/** Mirrors `en/pages/telegram.ts` key for key. */
export const telegram: Catalog<typeof telegramEn> = {
  title: 'Telegram-Einstellungen',
  description: 'Surowan mit Telegram verbinden.',
  connectionTitle: 'Verbindung',
  fieldStatus: 'Status',
  fieldSince: 'Seit',
  fieldBot: 'Bot',
  noBot: 'Noch keine Identität',
  status: {
    disabled: 'Deaktiviert',
    connected: 'Verbunden',
    network_error: 'Netzwerkfehler',
    config_error: 'Konfigurationsfehler',
  },
  reason: {
    unauthorized: 'Das Token wurde abgelehnt.',
    conflict: 'Das Token wird von einem anderen Prozess verwendet.',
    token_unreadable: 'Die Token-Quelle konnte nicht gelesen werden.',
  },
  tokenTitle: 'Bot-Token',
  tokenConfigured: 'Ein Token ist konfiguriert.',
  tokenMissing: 'Es ist kein Token konfiguriert.',
  sectionMissing: 'Noch keine Telegram-Einstellungen. Beim Speichern eines Tokens werden sie angelegt.',
  tokenLabel: 'Neues Bot-Token',
  tokenPlaceholder: '123456:ABC-DEF…',
  tokenHint: 'Das Token von @BotFather einfügen. Nach dem Speichern wird es nie wieder angezeigt.',
  save: 'Token speichern',
  saving: 'Wird gespeichert…',
  saved: 'Telegram-Token gespeichert',
  clear: 'Token löschen',
  clearTitle: 'Das Telegram-Bot-Token löschen?',
  clearDescription:
    'Telegram stoppt und trennt die Verbindung. Die übrigen Telegram-Einstellungen bleiben erhalten. Das lässt sich nicht rückgängig machen.',
  clearConfirm: 'Token löschen',
  cleared: 'Telegram-Token gelöscht',
  readFailed: 'Telegram-Einstellungen konnten nicht gelesen werden',
  bucketTitle: 'Nachrichtenpakete',
  bucketDescription: 'Speichern gilt ab dem nächsten Paket. Ein bereits sammelndes Paket behält seinen Takt.',
  bucketFields: {
    window: {
      label: 'Mindestwartezeit (Sekunden)',
      help: 'Ein Paket sammelt mindestens so lange.',
    },
    max: {
      label: 'Maximale Wartezeit (Sekunden)',
      help: 'Gezählt ab der ersten Nachricht des Pakets. Verlängerungen überschreiten sie nie.',
    },
    bump: {
      label: 'Verlängerung pro Nachricht (Sekunden)',
      help: 'Jede neue Nachricht hält das Paket mindestens so lange nach ihrem Eintreffen weiter offen. 0 bedeutet keine Verlängerung.',
    },
  },
  bucketMaxFollowsWindow: 'Wie die Mindestwartezeit',
  bucketErrors: {
    integer: 'Eine ganze Zahl Sekunden eingeben',
    range: 'Darf höchstens {{max}} sein',
    belowWindow: 'Muss mindestens der Mindestwartezeit entsprechen',
  },
  bucketRunning: 'Läuft: {{value}}',
  bucketUnchanged: 'Keine ungespeicherten Änderungen',
  bucketPending_one: '{{count}} ungespeicherte Änderung',
  bucketPending_other: '{{count}} ungespeicherte Änderungen',
  bucketInvalid: 'Vor dem Speichern die markierten Felder korrigieren.',
  bucketSave: 'Speichern und anwenden',
  bucketDiscard: 'Änderungen verwerfen',
};
