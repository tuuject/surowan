import type { Catalog } from '../../catalog.ts';
import type { warnings as warningsEn } from '../../en/pages/warnings.ts';

/** Mirrors `en/pages/warnings.ts` key for key. */
export const warnings: Catalog<typeof warningsEn> = {
  pageDescription: 'Systemzustandswarnungen, die Aufmerksamkeit brauchen, und der Verlauf der Ereigniswarnungen.',
  standingTitle: 'Dauerhafte Warnungen',
  eventsTitle: 'Ereigniswarnungen',
  unreadCount: '{{count, number}} ungelesen',
  unread: 'Ungelesen',
  standing: 'Dauerhaft',
  markRead: 'Als gelesen markieren',
  markedRead: 'Warnung als gelesen markiert',
  clearHistory: 'Warnungsverlauf leeren',
  clearTitle: 'Alle Ereigniswarnungen leeren?',
  clearDescription:
    'Jede Ereigniswarnung wird gelöscht, gelesen oder ungelesen. Dauerhafte Warnungen bleiben, solange ihre Bedingungen zutreffen. Das lässt sich nicht rückgängig machen.',
  clearConfirm: 'Warnungen leeren',
  cleared: '{{count, number}} Warnungen geleert',
  loadFailed: 'Warnungen konnten nicht geladen werden',
  noStanding: 'Keine dauerhaften Warnungen.',
  noEvents: 'Noch keine Ereigniswarnungen.',
  missingFields: 'Fehlt: {{fields}}',
  invalidApiKeys: 'Ungültige Schlüssel: {{keys}}',
  lastFailedAt: 'Letzter Fehlschlag: <time>{{time}}</time>',
  createdAt: 'Erstellt <time>{{time}}</time>',
  updatedAt: 'Aktualisiert <time>{{time}}</time>',
  readAt: 'Gelesen <time>{{time}}</time>',
  severity: {
    warning: 'Warnung',
    critical: 'Kritisch',
  },
  actions: {
    openDeveloper: 'Entwickler öffnen',
    openModels: 'Modelle öffnen',
    openInvocations: 'Aufrufe öffnen',
    openSettings: 'Einstellungen öffnen',
    openTelegram: 'Telegram-Einstellungen öffnen',
    openApiKeys: 'API-Schlüssel öffnen',
  },
  codes: {
    developer_payload_recording: {
      title: 'Rohdaten der Anfragen werden aufgezeichnet',
      body: 'Die Aufzeichnung für die Entwicklung ist aktiv, daher werden Momentaufnahmen der Modellanfragen und -antworten in der Datenbank gespeichert. Auf der Seite „Entwickler“ abschalten, sobald sie nicht mehr benötigt werden.',
    },
    agent_model_missing: {
      title: 'Kein Agent-Modell konfiguriert',
      body: 'Der Bot nimmt Nachrichten auf, kann aber keinen Aufruf starten, bis globaler Anbieter, Modell und Denkstufe gesetzt sind.',
    },
    vision_model_missing: {
      title: 'Kein Vision-Modell konfiguriert',
      body: 'Bildverständnis und Hintergrund-Indexierung der Sticker sind nicht verfügbar, bis Vision-Anbieter und -Modell gesetzt sind.',
    },
    invocation_failure_rate: {
      title: 'Fehlerquote der Aufrufe liegt über dem Schwellenwert',
      body: '{{failed}} der letzten {{total}} abgeschlossenen Aufrufe sind fehlgeschlagen ({{rate}} %), über dem Schwellenwert von {{threshold}} %.',
    },
    admin_login_failures: {
      title: 'Aufeinanderfolgende fehlgeschlagene Anmeldungen von Administratoren',
      body: 'Das Panel hat {{count}} aufeinanderfolgende Fehlschläge bei Benutzername/Passwort verzeichnet.',
    },
    telegram_network_error: {
      title: 'Verbindung zum Telegram-Server nicht möglich',
      body: 'Der Bot versucht es weiter. Sobald Telegram erreichbar ist, verbindet er sich automatisch wieder.',
    },
    telegram_config_error: {
      title: 'Fehler in der Telegram-Konfiguration',
      unauthorized: 'Das Telegram-Token wurde widerrufen oder ist ungültig',
      conflict: 'Dieses Telegram-Token wird bereits von einem anderen Programm verwendet',
      token_unreadable: 'Das Telegram-Token konnte nicht gelesen werden',
      body: {
        unknown: 'Telegram kann mit der aktuellen Token-Konfiguration nicht starten.',
        unauthorized: 'Das Bot-Token auf der Telegram-Seite durch ein gültiges Token von @BotFather ersetzen.',
        conflict: 'Ein anderer Prozess fragt mit diesem Token ab. Diesen stoppen oder ein anderes Token konfigurieren.',
        token_unreadable:
          'Die konfigurierte Token-Quelle konnte nicht gelesen werden. Das gespeicherte Token, die Umgebungsvariable oder den Befehl prüfen, auf den sie zeigt.',
      },
    },
    api_key_invalid_permissions: {
      title: 'API-Schlüssel mit ungültigen Berechtigungen',
      body: 'Ein oder mehrere API-Schlüssel haben ungültige Berechtigungen und können sich nicht anmelden. Auf der Seite API-Schlüssel für jeden einen Modus speichern.',
    },
    unknown: {
      title: 'Unbekannte Warnung: {{code}}',
      body: 'Diese Panel-Version hat keine Vorlage für den Warnungscode; die Rohdaten folgen.',
    },
  },
};
