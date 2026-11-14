export const feedback = {
  savedRestartRequired: 'Gespeichert, Neustart erforderlich',
  restartWaiting_one: '{{count}} Einstellung wirkt nach einem Neustart.',
  restartWaiting_other: '{{count}} Einstellungen wirken nach einem Neustart.',
  appliedAndWaiting_one: '{{applied}} angewendet; {{count}} wirkt nach einem Neustart.',
  appliedAndWaiting_other: '{{applied}} angewendet; {{count}} wirken nach einem Neustart.',
  applied: 'Angewendet',
  appliedDetail_one: '{{count}} Einstellung angewendet.',
  appliedDetail_other: '{{count}} Einstellungen angewendet.',
  saved: 'Gespeichert',
  savedDescription: 'In die Konfigurationsdatei gespeichert',
  writeConflict: 'Die Konfiguration wurde während der Bearbeitung geändert. Sie wurde neu geladen; erneut versuchen.',
};

export const match = {
  matched: 'Angaben zu {{model}} von {{provider}} aus models.dev',
  crossProviderNote: ' (unter einem anderen Anbieter geführt)',
  fuzzyNote: ' (ähnlicher, aber nicht identischer Name; jeden Punkt prüfen)',
};

export const source = {
  missing: 'nicht gefunden',
  from: 'aus {{source}}',
  crossProvider: 'models.dev (unter einem anderen Anbieter geführt)',
  fuzzy: 'models.dev (ähnlicher Modellname)',
  highestPrice: 'models.dev (höchster angegebener Preis)',
  reasoningDefault: 'nicht gefunden; als nicht denkend hinzugefügt',
  costDefault: 'nicht gefunden; mit 0 hinzugefügt',
};

export const switchConfirm = {
  title: 'Laufende Aufrufe stoppen und wechseln?',
  description:
    'Aufrufe, die noch mit dem aktuellen Modell laufen: {{count}}. Der Wechsel stoppt sie jetzt, und die Nachrichten, die sie beantworten, bekommen keine Antwort. Delegierte Aufgaben sind nicht betroffen, und neue Nachrichten gehen an das neue Modell.',
  confirm: 'Stoppen und wechseln',
  stopped_one: '{{count}} laufender Aufruf gestoppt.',
  stopped_other: '{{count}} laufende Aufrufe gestoppt.',
};

export const validation = {
  idRequired: 'Modell-ID ist erforderlich',
  inputRequired: 'Mindestens eine Eingabe auswählen: Text oder Bild',
  positiveInteger: 'Eine positive ganze Zahl eingeben',
  maxTokensExceeds: 'Die maximale Ausgabe kann die Kontextlänge nicht überschreiten',
  costRequired: 'Alle vier Preise ausfüllen (0 eintragen, wenn kostenlos)',
};
