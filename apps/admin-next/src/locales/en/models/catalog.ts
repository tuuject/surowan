export const picker = {
  discoverTitle: 'Fetch models',
  manualTitle: 'Add models manually',
  discoverDescription:
    'The models {{alias}} offers, fetched with its saved API key. Pick the ones to add; model details are filled in automatically.',
  manualDescription: 'Add models to {{alias}} by hand: enter model IDs and their details are looked up automatically.',
  endpointLabel: 'Requested from: ',
  fetchAgain: 'Fetch again',
  fetching: 'Fetching…',
  idsLabel: 'Model IDs (one per line, or separated by commas)',
  metadataUnavailable:
    "Model details couldn't be looked up ({{error}}). You can still add the models, but context length, max output and accepted input have to be filled in by hand.",
  lookingUp: 'Looking up…',
  adding: 'Adding…',
  addOne: 'Add {{count}} model',
  addMany: 'Add {{count}} models',
};

export const drafts = {
  search: 'Search models',
  configured: 'Already added',
  confirmed: 'Confirmed',
  toConfirm: '{{count}} to confirm',
  context: 'context length',
  maxOutput: 'max output',
  input: 'input',
  reasoning: 'thinking',
  thinking: 'thinking levels',
  piDefault: 'default levels',
  yes: 'yes',
  no: 'no',
  reasoningDefaulted: "Couldn't find whether this model thinks; it will be added as a model that doesn't.",
};

export const edit = {
  confirmMarker: 'to confirm',
  confirmIntro: 'Confirm or fill in: {{fields}}. Nothing is filled in by default.',
  id: 'Model ID',
  name: 'Display name',
  nickname: 'Nickname',
  contextWindow: 'Context length (tokens)',
  maxTokens: 'Max output (tokens)',
  input: 'Accepted input',
  reasoning: 'Supports thinking',
  thinkingLevels: 'Thinking levels',
  thinkingHint: 'Check the thinking levels this model supports. Leave all unchecked to use the default levels.',
  toolSchema: 'Tool compatibility',
  toolSchemaHint:
    'Leave this on Automatic for most models. If tool calls fail with “unsupported schema keyword”, switch to Simplified.',
  toolSchemaMinimal: 'Simplified',
  cost: 'Price (USD per 1M tokens)',
  costInput: 'Input',
  costOutput: 'Output',
  costCacheRead: 'Cache read',
  costCacheWrite: 'Cache write',
  advanced: 'Advanced',
  advancedHint:
    'Usually leave these alone. Auto works out the right behavior from the provider; set one by hand only when calls fail and you know why.',
  auto: 'Auto',
  automatic: 'Automatic',
};

export const compat = {
  supportsDeveloperRole: 'Use the newer system-prompt role',
  thinkingFormat: 'Thinking parameter style',
  maxTokensField: 'Max output parameter style',
  requiresReasoningContent: 'Include the thinking field in history',
  cacheControlFormat: 'Prompt cache markers',
  on: 'On',
  off: 'Off',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  together: 'Together AI',
  zai: 'Z.ai',
  qwen: 'Qwen',
  stringThinking: 'Text level (other services)',
  maxCompletionTokens: 'Newer (OpenAI official)',
  maxTokens: 'Classic (most compatible services)',
  anthropic: 'Anthropic format',
};

export const shared = {
  select: 'Select {{id}}',
  emptyList: 'No matching models.',
  selectedCount: '{{count}} selected',
  unresolvedSuffix: '{{ids}} still have items to confirm',
  acceptListed: 'Accept these values ({{count}})',
};
