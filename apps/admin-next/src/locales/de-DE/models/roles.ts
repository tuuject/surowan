export const roles = {
  pageDescription:
    'Für jede Aufgabe des Bots das Modell wählen und festlegen, wie stark es denkt. Gespeicherte Änderungen wirken sofort.',
  form: {
    pending_one: '{{count}} ungespeicherte Änderung',
    pending_other: '{{count}} ungespeicherte Änderungen',
    unchanged: 'Keine ungespeicherten Änderungen',
    saved: 'Alle Änderungen gespeichert',
    save: 'Speichern',
    saving: 'Wird gespeichert…',
    discard: 'Änderungen verwerfen',
    partial: 'Teilweise gespeichert. {{message}} Die übrigen Änderungen sind weiterhin hier.',
    refreshFailed:
      'Die Änderungen wurden gesendet, aber die Seite konnte die Konfiguration nicht neu laden: {{message}} Die Seite neu laden, bevor erneut gespeichert wird.',
    missingModel: '{{model}} ist nicht mehr konfiguriert. Ein anderes Modell wählen und erneut speichern.',
    cardChanged: 'Ungespeicherte Änderungen',
  },
  manageProviders: 'Anbieter verwalten',
  addProvider: 'Anbieter hinzufügen',
  noProvidersTitle: 'Noch keine Anbieter',
  noProvidersDescription:
    'Auf der Seite „Anbieter“ einen Anbieter und die gewünschten Modelle hinzufügen und dann hier Aufgaben zuweisen.',
  modelLabel: 'Modell',
  thinkingLabel: 'Denkaufwand',
  levelUnset: 'Nicht gesetzt',
  unset: 'Nicht gesetzt',
  notReasoning: 'Dieses Modell hat keinen Denkaufwand zum Einstellen',
  searchModels: 'Modelle suchen',
  noMatchingModels: 'Kein Modell entspricht dieser Suche.',
  useAs: 'Verwenden als',
  useAsAria: '{{model}} verwenden als',
  agent: {
    title: 'Agent-Modell',
    short: 'Agent',
    description: 'Das Hauptmodell, das Chats liest und über Antworten entscheidet. Ohne es antwortet der Bot nicht.',
    resetsNote: 'Wird bei einem Modellwechsel auf die schwächste Stufe zurückgesetzt',
  },
  vision: {
    title: 'Vision-Modell',
    short: 'Vision',
    description:
      'Beschreibt Bilder und Sticker: Bildauswertung und Sticker-Indexierung des Agenten hängen davon ab. Ohne es sind beide nicht verfügbar.',
  },
  tool: {
    title: 'Tool-Modell',
    short: 'Tool',
    description:
      'Führt Hintergrundaufgaben aus, etwa Wörterbuch-Zusammenführungen und Gruppengedächtnis. Folgt ohne eigene Einstellung dem Agent-Modell.',
    defaultGroup: 'Standard',
    inherit: 'Agent-Modell erben',
    levelInherited: 'Folgt dem Agent-Modell',
  },
};

export const kind = {
  builtin: 'Integriert',
  custom: 'Benutzerdefiniert',
};

export const apiFormat = {
  openaiCompletions: 'OpenAI (Chat Completions)',
  openaiResponses: 'OpenAI (Responses)',
  anthropicMessages: 'Anthropic',
  googleGenerativeAi: 'Google',
};

export const modality = {
  text: 'Text',
  image: 'Bild',
};

export const toolModel = {
  savedInherited: 'Das Tool-Modell folgt jetzt dem Agent-Modell',
  saved: 'Tool-Modell gewechselt; Denkaufwand ist {{level}}',
  conflict:
    'Die Einstellungen wurden während der Bearbeitung an anderer Stelle geändert. Die Seite wurde aktualisiert; erneut wählen.',
};
