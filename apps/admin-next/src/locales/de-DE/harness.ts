import type { Catalog } from '../catalog.ts';
import type { harness as harnessEn } from '../en/harness.ts';

/** Mirrors `en/harness.ts` key for key; the annotation fails the build on drift. */
export const harness: Catalog<typeof harnessEn> = {
  loadFailed: 'Harness-Einstellungen konnten nicht geladen werden',
  save: 'Speichern und anwenden',
  saving: 'Wird gespeichert…',
  discard: 'Änderungen verwerfen',
  unchanged: 'Keine ungespeicherten Änderungen',
  pending_one: '{{count}} ungespeicherte Änderung',
  pending_other: '{{count}} ungespeicherte Änderungen',
  invalid: 'Vor dem Speichern die markierten Felder korrigieren.',
  running: 'Läuft: {{value}}',
  noLimit: 'Kein Limit',
  noLimitPlaceholder: 'Leer bedeutet kein Limit',
  on: 'Ein',
  off: 'Aus',
  sections: {
    navigation: 'Formularabschnitte',
    jump: 'Zu Abschnitt springen',
    invalid: ', muss korrigiert werden',
    changed: ', ungespeicherte Änderungen',
  },
  errors: {
    integer: 'Eine ganze Zahl eingeben',
    number: 'Eine Zahl eingeben',
    min: 'Muss mindestens {{min}} sein',
    max: 'Darf höchstens {{max}} sein',
    greaterThan: 'Muss größer als {{min}} sein',
    lines: 'Mindestens eine Zeile eingeben',
    option: 'Eine der aufgeführten Optionen wählen',
  },
  groups: {
    budget: {
      title: 'Budget und Parallelität',
    },
    send: {
      title: 'Sendeverhalten',
    },
    rateLimits: {
      title: 'Mengenbegrenzungen',
    },
    context: {
      title: 'Kontext',
    },
    proactiveReply: {
      title: 'Proaktive Antworten',
    },
  },
  fields: {
    'daily_budget.max_tokens': {
      label: 'Tägliches Token-Budget',
      description:
        'Tagesobergrenze für Tokens, gemeinsam für Antworten und Bildauswertung. Eine Senkung wirkt ab dem nächsten Modellaufruf.',
    },
    max_concurrency: {
      label: 'Maximal gleichzeitige Aufrufe',
      description: 'Wie viele Aufrufe gleichzeitig laufen dürfen.',
    },
    history_messages: {
      label: 'Verlaufsnachrichten',
      description: 'Wie viele frühere Nachrichten jeder neue Aufruf mitbringt.',
    },
    context_stop_ratio: {
      label: 'Abbruchschwelle des Kontexts',
      description:
        'Sobald die Eingabe diesen Anteil der Kontextlänge des Modells füllt, antwortet der Lauf ein letztes Mal und endet.',
    },
    send_max_text_length: {
      label: 'Maximale Textlänge',
      description: 'Längster Text einer einzelnen Nachricht in Zeichen (1–4096).',
    },
    send_disallow_blank_lines: {
      label: 'Leerzeilen nicht zulassen',
      description:
        'Texte mit Leerzeilen ablehnen; Absätze dürfen nur durch einen einzelnen Zeilenumbruch getrennt werden.',
    },
    send_nudge_enabled: {
      label: 'Sende-Erinnerung',
      description: 'Das Modell daran erinnern zu senden, wenn es enden will, ohne etwas gesendet zu haben.',
    },
    send_barrier_enabled: {
      label: 'Auf neue Nachrichten warten',
      description: 'Treffen vor einem Senden neue Nachrichten ein, liest das Modell sie vor der Antwort.',
    },
    allow_reply_message_multiple_times: {
      label: 'Mehrere Antworten auf eine Nachricht',
      description:
        'Erlauben, auf dieselbe Nachricht mehrfach zu antworten. Budgets und Mengenbegrenzungen gelten weiterhin.',
    },
    send_duplicate_guard_enabled: {
      label: 'Schutz vor doppeltem Senden',
      description:
        'Einen Text oder Sticker ablehnen, der im selben Aufruf schon gesendet wurde; nach mehr als 3 Ablehnungen den Lauf beenden.',
    },
    send_empty_text_strategy: {
      label: 'Sendungen ohne Text',
      description: 'Was passiert, wenn das Modell eine Textnachricht ohne Text sendet.',
      options: {
        reject: 'Aufruf ablehnen',
        silent_success: 'Still erfolgreich (nichts senden)',
        random_text: 'Einen zufälligen Ersatztext senden',
      },
    },
    send_empty_text_fallback_texts: {
      label: 'Ersatztexte',
      description: 'Einer pro Zeile; bei jedem Mal wird zufällig einer gewählt.',
    },
    'rate_limits.sends_per_window': {
      label: 'Sendungen pro Zeitfenster',
      description:
        'Wie viele Nachrichten jeder Chat in einem Zeitfenster senden darf; fehlgeschlagene Sendungen zählen mit.',
    },
    'rate_limits.window_seconds': {
      label: 'Länge des Zeitfensters (Sekunden)',
      description: 'Der Zeitraum, auf den sich die Sendezählung bezieht.',
    },
    'rate_limits.turns_per_injection': {
      label: 'Runden pro Nachrichtenpaket',
      description: 'Erlaubte Runden nach jedem neuen Nachrichtenpaket, bevor der Lauf endet.',
    },
    'context.retained_sends_target': {
      label: 'Ziel für behaltene Sendungen',
      description: 'Sendungen, die nach der Kontextbereinigung bleiben; muss kleiner als das Maximum sein.',
    },
    'context.retained_sends_max': {
      label: 'Maximum behaltener Sendungen',
      description: 'Der Kontext wird bereinigt, sobald er mehr Sendungen als dies enthält.',
    },
    'context.hard_token_ratio': {
      label: 'Anteil für erzwungene Bereinigung',
      description:
        'Anteil der Kontextlänge des Modells, der eine Bereinigung erzwingt; darf die Abbruchschwelle nicht überschreiten.',
    },
    'context.ref_ttl_hours': {
      label: 'Lebensdauer von Referenzen (Stunden)',
      description:
        'Wie lange Bild-, Sticker- und Antwortreferenzen gültig bleiben. Gilt für ab jetzt ausgestellte Referenzen.',
    },
    'context.idle_grace_seconds': {
      label: 'Nachlaufzeit (Sekunden)',
      description:
        'Wie lange ein beendeter Lauf auf das nächste Nachrichtenpaket wartet. 0 bedeutet kein Warten; andernfalls mindestens die längste Wartezeit eines Nachrichtenpakets.',
    },
    'context.max_wall_clock_seconds': {
      label: 'Maximale Laufzeit (Sekunden)',
      description: 'Längste Dauer eines einzelnen Laufs; muss die Nachlaufzeit überschreiten.',
    },
    'context.agent_cache_size': {
      label: 'Größe des Speicher-Cache',
      description: 'Wie viele Kontexte im Speicher bleiben. Ein kleinerer Wert verliert nie Verlauf.',
    },
    'proactive_reply.enabled': {
      label: 'Proaktive Antworten planen',
      description:
        'Wenn ein: Gruppennachrichten, die den Bot nicht ansprechen, bekommen nur eine Antwortchance, wenn ein Losverfahren trifft. Wenn aus: jedes Paket bekommt eine Chance. Private Chats sind nie betroffen.',
    },
    'proactive_reply.base_probability': {
      label: 'Chance beim ersten Versuch',
      description: 'Chance des ersten Losverfahrens nach einem Treffer, von 0 bis 1 (0.2 bedeutet 20 %).',
    },
    'proactive_reply.increment': {
      label: 'Erhöhung nach jedem Fehlversuch',
      description: 'Wird nach jedem Fehlversuch zur Chance addiert, von 0 bis 1. Ein Treffer setzt sie zurück.',
    },
    'proactive_reply.hard_pity': {
      label: 'Maximale Versuche',
      description: 'Das Losverfahren bei diesem Versuch trifft immer.',
    },
  },
};
