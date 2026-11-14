export const picker = {
  discoverTitle: 'Modelle abrufen',
  manualTitle: 'Modelle manuell hinzufügen',
  discoverDescription:
    'Die von {{alias}} angebotenen Modelle, abgerufen mit seinem gespeicherten API-Schlüssel. Die gewünschten auswählen; Modelldetails werden automatisch gefüllt.',
  manualDescription:
    'Modelle bei {{alias}} von Hand hinzufügen: Modell-IDs eingeben, die Details werden automatisch nachgeschlagen.',
  endpointLabel: 'Abgefragt von: ',
  fetchAgain: 'Erneut abrufen',
  fetching: 'Wird abgerufen…',
  idsLabel: 'Modell-IDs (eine pro Zeile oder durch Kommas getrennt)',
  metadataUnavailable:
    'Modelldetails konnten nicht nachgeschlagen werden ({{error}}). Die Modelle lassen sich trotzdem hinzufügen, aber Kontextlänge, maximale Ausgabe und akzeptierte Eingabe müssen von Hand gefüllt werden.',
  lookingUp: 'Wird nachgeschlagen…',
  adding: 'Wird hinzugefügt…',
  addOne: '{{count}} Modell hinzufügen',
  addMany: '{{count}} Modelle hinzufügen',
};

export const drafts = {
  search: 'Modelle suchen',
  configured: 'Bereits hinzugefügt',
  confirmed: 'Bestätigt',
  toConfirm: '{{count}} zu bestätigen',
  context: 'Kontextlänge',
  maxOutput: 'maximale Ausgabe',
  input: 'Eingabe',
  reasoning: 'Denken',
  thinking: 'Denkstufen',
  piDefault: 'Standardstufen',
  yes: 'ja',
  no: 'nein',
  reasoningDefaulted:
    'Ob dieses Modell denkt, ließ sich nicht ermitteln; es wird als nicht denkendes Modell hinzugefügt.',
};

export const edit = {
  confirmMarker: 'zu bestätigen',
  confirmIntro: 'Bestätigen oder ergänzen: {{fields}}. Nichts ist standardmäßig gefüllt.',
  id: 'Modell-ID',
  name: 'Anzeigename',
  nickname: 'Kurzname',
  contextWindow: 'Kontextlänge (Tokens)',
  maxTokens: 'Maximale Ausgabe (Tokens)',
  input: 'Akzeptierte Eingabe',
  reasoning: 'Unterstützt Denken',
  thinkingLevels: 'Denkstufen',
  thinkingHint:
    'Die von diesem Modell unterstützten Denkstufen ankreuzen. Alle abgewählt lassen, um die Standardstufen zu verwenden.',
  toolSchema: 'Tool-Kompatibilität',
  toolSchemaHint:
    'Für die meisten Modelle auf Automatisch lassen. Scheitern Tool-Aufrufe mit „unsupported schema keyword“, auf Vereinfacht wechseln.',
  toolSchemaMinimal: 'Vereinfacht',
  cost: 'Preis (USD pro 1 Mio. Tokens)',
  costInput: 'Eingabe',
  costOutput: 'Ausgabe',
  costCacheRead: 'Cache gelesen',
  costCacheWrite: 'Cache geschrieben',
  advanced: 'Erweitert',
  advancedHint:
    'In der Regel unverändert lassen. Automatisch leitet das richtige Verhalten vom Anbieter ab; nur von Hand setzen, wenn Aufrufe scheitern und der Grund bekannt ist.',
  auto: 'Automatisch',
  automatic: 'Automatisch',
};

export const compat = {
  supportsDeveloperRole: 'Die neuere System-Prompt-Rolle verwenden',
  thinkingFormat: 'Stil des Denk-Parameters',
  maxTokensField: 'Stil des Parameters für maximale Ausgabe',
  requiresReasoningContent: 'Das Denk-Feld in den Verlauf aufnehmen',
  cacheControlFormat: 'Markierungen für den Prompt-Cache',
  on: 'Ein',
  off: 'Aus',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  together: 'Together AI',
  zai: 'Z.ai',
  qwen: 'Qwen',
  stringThinking: 'Textstufe (andere Dienste)',
  maxCompletionTokens: 'Neuer (offizielles OpenAI)',
  maxTokens: 'Klassisch (die meisten kompatiblen Dienste)',
  anthropic: 'Anthropic-Format',
};

export const shared = {
  select: '{{id}} auswählen',
  emptyList: 'Keine passenden Modelle.',
  selectedCount: '{{count}} ausgewählt',
  unresolvedSuffix: '{{ids}} haben noch zu bestätigende Punkte',
  acceptListed: 'Diese Werte übernehmen ({{count}})',
};
