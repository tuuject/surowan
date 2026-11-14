export const headers = {
  header: 'Name des Headers',
  value: 'Wert',
  keepPlaceholder: 'Gespeichert; leer lassen, um ihn zu behalten',
  valuesRequired: 'Nach dem Ändern der API-Adresse alle Header-Werte erneut eingeben',
  add: 'Header hinzufügen',
  needsName: 'Jeder Header braucht einen Namen',
  listedTwice: 'Header {{name}} ist doppelt aufgeführt',
  needsValue: 'Header {{name}} braucht einen Wert',
};

export const connection = {
  title: 'Verbindung',
  test: 'Testen',
  baseUrl: 'API-Adresse',
  baseUrlHint: 'Die API-Adresse aus der Dokumentation des Anbieters, meist endend auf /v1.',
  builtinHint: 'Integrierte Anbieter bringen Adresse und Format bereits mit; nur der API-Schlüssel wird benötigt.',
  api: 'API-Format',
  apiHint: 'Unsicher? OpenAI (Chat Completions) wählen; die meisten Dienste unterstützen es.',
  responsesWarning:
    'Die meisten Anbieter unterstützen dieses API-Format nicht. Bei Unsicherheit OpenAI (Chat Completions) wählen.',
  builtinProvider: 'Integrierter Anbieter',
  apiKey: 'API-Schlüssel',
  keepHint: 'Gespeichert; leer lassen, um ihn zu behalten',
  keepHintChanged: 'nach dem Ändern der API-Adresse erneut eingeben',
  headersTitle: 'Eigene Header',
  headersHint:
    'Nur nötig, wenn der Anbieter es verlangt, etwa ein zusätzliches Token, das manche Relay-Dienste voraussetzen.',
  changedWarning:
    'Aus Sicherheitsgründen verlangt eine geänderte API-Adresse, dass API-Schlüssel und alle Header-Werte im selben Speichervorgang erneut eingegeben werden.',
  staleWarning:
    'Die Konfiguration wurde seit Beginn der Bearbeitung geändert. Neu laden, um die aktuelle Fassung zu bearbeiten; ungespeicherte Änderungen hier gehen verloren.',
  needsApiKey: 'Nach dem Ändern der API-Adresse den API-Schlüssel erneut eingeben',
  headerRemoved: 'Header lassen sich nicht entfernen, während sich die API-Adresse ändert: {{names}}',
};

export const wizard = {
  stepConnection: 'Verbindung',
  stepCredentials: 'API-Schlüssel',
  stepModels: 'Modelle',
  title: 'Neuer Anbieter: {{step}}',
  description: 'Der Anbieter wirkt, sobald er angelegt ist.',
  kind: 'Typ',
  builtinKind: 'Integrierter Anbieter (aus einer Liste wählen)',
  customKind: 'Benutzerdefiniert (Adresse selbst eingeben, für Relays oder selbst gehostete Dienste)',
  alias: 'Name',
  aliasHint:
    'Identifiziert den Anbieter im Panel und lässt sich später nicht ändern. Mit einem Buchstaben beginnen; nur Buchstaben, Ziffern, Unterstriche und Bindestriche, bis 64 Zeichen.',
  aliasInvalid: 'Mit einem Buchstaben beginnen und nur Buchstaben, Ziffern, Unterstriche oder Bindestriche verwenden.',
  piProvider: 'Anbieter',
  loadingPresets: 'Integrierte Anbieter werden geladen…',
  pickPreset: 'Einen integrierten Anbieter wählen',
  presetBaseUrl: 'API-Adresse: ',
  googleNote: 'Die Version gehört in die Adresse, zum Beispiel endend auf /v1beta.',
  apiKeyHint: 'In der Konsole des Anbieters anlegen. Er wird zum Auflisten und Aufrufen von Modellen verwendet.',
  headersOptional: 'Eigene Header (optional)',
  tempModeNote:
    'Der Anbieter ist noch nicht angelegt, daher wird die Liste mit dem gerade eingegebenen API-Schlüssel abgerufen. Nur die ausgewählten Modelle werden hinzugefügt.',
  fetch: 'Modelle abrufen',
  idsLabel: 'Oder Modell-IDs von Hand eingeben (eine pro Zeile oder durch Kommas getrennt)',
  lookup: 'Modelldetails nachschlagen',
  enterApiKeyFirst: 'Zuerst den API-Schlüssel eingeben',
  enterModelId: 'Mindestens eine Modell-ID eingeben',
  confirmTitle: '{{model}} bestätigen',
  confirmDescription:
    'Diese Angaben wurden automatisch nachgeschlagen und können abweichen. Vor dem Speichern jeden Punkt mit „zu bestätigen“ prüfen.',
  next: 'Weiter',
  createProvider: 'Anbieter anlegen',
};
