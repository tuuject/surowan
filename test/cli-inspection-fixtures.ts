// Shared fixtures for the split `surowan-utils inspection commands` suites.
export const API_KEY = 'test-api-key-inspect';
export const ENV = (baseUrl: string) => ({ SUROWAN_ENDPOINT: baseUrl, SUROWAN_API_KEY: API_KEY });

export const CONFIG_VIEW = {
  source: 'active',
  generation: 12,
  active_hash: 'active-hash',
  file_hash: 'file-hash',
  config: { agent: { model: 'test-model' }, telegram: { token_env: 'TELEGRAM_TOKEN' } },
};

export const PROMPT_GLOBAL = {
  source: 'active',
  scope: 'global',
  chat_id: null,
  prompt: 'global prompt body',
  core_read_only: true,
  generation: 12,
  hash: 'prompt-hash',
};

export const PROMPT_GROUP = {
  source: 'file',
  scope: 'group',
  chat_id: '-100123',
  prompt: 'group prompt body',
  core_read_only: true,
  generation: 3,
  hash: 'group-hash',
};

export const ACTIVE_PROMPTS = {
  source: 'active',
  source_invocation_id: '42',
  global_prompt: 'current global',
  group_prompt: 'current group',
  template_values: { time: '2026-10-06 10:00' },
  core_read_only: true,
};

export const PREFLIGHT = {
  available: true,
  reason: null,
  message: null,
  prompt_overrides_available: true,
  omitted_images: 0,
  scene: {
    cutoff_at: '2026-10-06T10:00:00Z',
    source_bucket_id: '1',
    message_count: 1,
    history_count: 0,
    omitted_messages: 0,
  },
  fidelity: {
    input: 'historical_public_chat',
    prompt_selection: 'current_chat_config',
    tool_selection: 'current_registry',
  },
};

export const LIST_ITEM = {
  id: '9',
  state: 'completed',
  created_at: '2026-10-06T12:00:00.000Z',
  chat: { telegram_chat_id: '-100123', title: 'Inspect Group', username: null, message_thread_id: 0 },
  total_tokens: 10,
  total_cost: 0.001,
  matched_messages: [
    {
      source: 'incoming',
      telegram_message_id: '55',
      telegram_send_id: null,
      at: '2026-10-06T11:58:00Z',
      text: 'hello keyword',
    },
    {
      source: 'bot',
      telegram_message_id: null,
      telegram_send_id: '77',
      at: '2026-10-06T11:59:30Z',
      text: 'matched reply',
    },
  ],
};

export const PLAIN_ITEM = {
  id: '9',
  state: 'completed',
  created_at: '2026-10-06T12:00:00.000Z',
  chat: { telegram_chat_id: '-100123', title: 'Inspect Group', username: null, message_thread_id: 0 },
  total_tokens: 10,
  total_cost: 0.001,
};

export const MODELS = {
  source: 'active',
  generation: 12,
  models: [
    {
      provider: 'other',
      model: 'vendor/text-model',
      name: 'Text Model',
      context_window: 32_000,
      max_tokens: 4_000,
      input: ['text'],
      reasoning: false,
      thinking_levels: ['off'],
    },
  ],
};
