import { isIP } from 'node:net';
import {
  builtinModelApi,
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  SUPPORTED_PROVIDER_APIS,
} from './builtin-providers.ts';
import type {
  AgentRuntimeConfig,
  AgentSettings,
  FileConfig,
  ModelFileConfig,
  ParticipationConfig,
  ProviderApi,
  ProviderConfig,
} from './config.ts';
import { activeVisionModel, resolveAgentSection, resolveAgentSettings } from './config-resolve.ts';
import { supportedThinkingLevels } from './thinking-levels.ts';

/**
 * Cross-field rules the schema cannot express: provider aliases and model
 * references, per-API model constraints, chat and MCP uniqueness, endpoints,
 * timezones and Conversation Context bounds.
 */

/** Provider aliases appear in Admin API paths and in `restart_required` strings. */
export const PROVIDER_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Which compat overrides each API adapter honours; anything else is rejected. */
const COMPAT_FIELDS_BY_API: Readonly<Record<ProviderApi, readonly string[]>> = {
  'openai-completions': [
    'supports_developer_role',
    'thinking_format',
    'max_tokens_field',
    'requires_reasoning_content',
    'cache_control_format',
  ],
  'openai-responses': ['supports_developer_role'],
  'anthropic-messages': [],
  'google-generative-ai': [],
};

export function adminPublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('admin.public_url must be an HTTPS origin (HTTP localhost is allowed for local use)');
  }
  if (isIP(url.hostname) !== 0 || url.hostname.startsWith('[')) {
    throw new Error('admin.public_url must use a domain name, not an IP address (use localhost for local testing)');
  }
  const local = url.hostname === 'localhost';
  if (
    value !== value.trim() ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    ![url.origin, `${url.origin}/`].includes(value)
  ) {
    throw new Error(
      'admin.public_url must be a canonical HTTPS origin without credentials, path, query or fragment (HTTP localhost is allowed for local use)',
    );
  }
  return url.origin;
}

export function validateSemantics(config: FileConfig): void {
  if (config.admin?.public_url !== undefined) {
    adminPublicOrigin(config.admin.public_url);
  }
  validateTimezone(config.timezone, 'timezone');
  validateParticipation(config.telegram.participation, 'telegram.participation');
  const agent = resolveAgentSection(config.agent);
  validateContextConfig(config, agent);
  const chatIds = new Set<number>();
  for (const chat of config.telegram.chats) {
    if (!Number.isSafeInteger(chat.id) || chat.id === 0) {
      throw new Error(`Invalid Telegram chat ID: ${chat.id}`);
    }
    if (chatIds.has(chat.id)) {
      throw new Error(`Duplicate Telegram chat ID: ${chat.id}`);
    }
    chatIds.add(chat.id);
    if (chat.participation !== undefined) {
      if (chat.id > 0) {
        throw new Error(`Chat ${chat.id} is a private chat and cannot configure participation`);
      }
      validateParticipation(chat.participation, `chat ${chat.id} participation`);
    }
    if (chat.proactive_reply !== undefined && chat.id > 0) {
      throw new Error(`Chat ${chat.id} is a private chat and cannot configure proactive_reply`);
    }
    if (chat.timezone !== undefined) {
      validateTimezone(chat.timezone, `chat ${chat.id} timezone`);
    }
    for (const ignoredUserId of chat.ignored_user_ids ?? []) {
      if (!Number.isSafeInteger(ignoredUserId) || ignoredUserId === 0) {
        throw new Error(`Invalid ignored Telegram user ID in chat ${chat.id}: ${ignoredUserId}`);
      }
    }
    if (chat.provider !== undefined || chat.model !== undefined) {
      if (chat.provider === undefined || chat.model === undefined) {
        throw new Error(`Chat ${chat.id}: provider and model must both be set when overriding agent settings`);
      }
      validateModelReference(config, chat.provider, chat.model, `chat ${chat.id}`, ['text']);
    }
    if (chat.provider !== undefined || chat.thinking_level !== undefined) {
      validateAgentThinkingLevel(config, resolveAgentSettings(config, chat), `chat ${chat.id}`);
    }
  }
  for (const adminId of config.telegram.admins ?? []) {
    if (!Number.isSafeInteger(adminId) || adminId === 0) {
      throw new Error(`Invalid Telegram admin user ID: ${adminId}`);
    }
  }
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.alias, 'sticker set alias');
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.name, 'sticker set name');
  const providerAliases = new Set(Object.keys(config.providers));
  // The agent model reference is validated only when both fields are written:
  // a missing provider/model pair never reaches a model lookup at runtime.
  if (agent.provider !== undefined && agent.model !== undefined) {
    validateModelReference(config, agent.provider, agent.model, 'agent', ['text']);
  }
  // Like the agent pair, the vision pair is validated only when both halves are written.
  const vision = activeVisionModel(config.vision);
  if (vision !== undefined) {
    validateModelReference(config, vision.provider, vision.model, 'vision', ['image']);
  }
  if (
    (agent.provider !== undefined && !providerAliases.has(agent.provider)) ||
    (vision !== undefined && !providerAliases.has(vision.provider))
  ) {
    throw new Error('Agent and vision providers must reference configured aliases');
  }
  for (const [alias, provider] of Object.entries(config.providers)) {
    if (!PROVIDER_ALIAS_PATTERN.test(alias)) {
      throw new Error(
        `Provider alias ${JSON.stringify(alias)} must match ${PROVIDER_ALIAS_PATTERN.source}: the alias is a URL path segment and part of restart path strings`,
      );
    }
    assertUnique(provider.models, (model) => model.id, `provider ${alias} model ID`);
    if (provider.kind === 'custom') {
      validateEndpoint(provider.base_url, `provider ${alias} base_url`);
      for (const model of provider.models) {
        assertModelConfig(provider.api, model, `Provider ${alias} model ${model.id}`);
      }
    } else {
      // pi 1.x builtin catalogs mix chat adapters inside one provider, so each
      // configured model is validated against the api of its own catalog entry.
      for (const model of provider.models) {
        assertModelConfig(
          resolveBuiltinModelApi(alias, provider, model.id),
          model,
          `Provider ${alias} model ${model.id}`,
        );
      }
    }
  }
  validateAgentThinkingLevel(config, agent, 'agent');
  const toolModel = config.tool_model;
  if (toolModel !== undefined) {
    validateModelReference(config, toolModel.provider, toolModel.model, 'tool_model', ['text']);
    validateAgentThinkingLevel(config, toolModel, 'tool_model');
  }
  const servers = config.mcp?.servers ?? [];
  assertUnique(servers, (server) => server.alias, 'MCP server alias');
  for (const server of servers) {
    if (server.transport === 'streamable_http') {
      validateEndpoint(server.url, `MCP server ${server.alias} URL`, { allowQuery: true });
    }
    if (server.tools === '*' && server.default_tool_policy === undefined) {
      throw new Error(`MCP server ${server.alias} wildcard tools require default_tool_policy`);
    }
    const policies = server.tool_policies ?? [];
    assertUnique(policies, (policy) => policy.name, `MCP server ${server.alias} tool policy`);
    if (server.tools !== '*') {
      const allowed = new Set(server.tools);
      for (const policy of policies) {
        if (!allowed.has(policy.name)) {
          throw new Error(`MCP server ${server.alias} policy references unlisted tool ${policy.name}`);
        }
      }
      for (const tool of server.tools) {
        if (!policies.some((policy) => policy.name === tool)) {
          throw new Error(`MCP server ${server.alias} tool ${tool} has no policy`);
        }
      }
    }
  }
}

function validateModelReference(
  config: FileConfig,
  providerAlias: string,
  modelId: string,
  role: string,
  requiredInputs: readonly ('text' | 'image')[],
): void {
  const provider = config.providers[providerAlias];
  if (provider === undefined) {
    throw new Error(`${role}.provider references unknown alias ${providerAlias}`);
  }
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new Error(`${role}.model ${modelId} is absent from provider ${providerAlias}`);
  }
  for (const requiredInput of requiredInputs) {
    if (!model.input.includes(requiredInput)) {
      throw new Error(`${role}.model ${modelId} lacks ${requiredInput} input capability`);
    }
  }
}

/**
 * The API one configured model of a builtin alias speaks: its entry in Pi's
 * catalog, or — for ids the catalog does not list — the provider's uniform
 * catalog api. The uniform fallback keeps single-adapter providers accepting
 * catalog-external model ids; on a mixed-catalog provider there is nothing to
 * inherit, so such an id is a configuration error.
 */
export function resolveBuiltinModelApi(
  alias: string,
  provider: ProviderConfig & { kind: 'builtin' },
  modelId: string,
): ProviderApi {
  const source = findBuiltinProvider(provider.provider);
  if (source === undefined) {
    throw new Error(`Provider ${alias} references unknown built-in provider ${provider.provider}`);
  }
  if (!isSupportedBuiltinPreset(source)) {
    throw new Error(`Provider ${alias} built-in ${provider.provider} cannot be driven from a configured API key`);
  }
  const api = builtinModelApi(source, modelId);
  if (api === null || !SUPPORTED_PROVIDER_APIS.includes(api)) {
    throw new Error(
      `Provider ${alias} model ${modelId} has no supported API (${SUPPORTED_PROVIDER_APIS.join(', ')}) in Pi's ${provider.provider} catalog`,
    );
  }
  return api as ProviderApi;
}

/**
 * The model invariants a provider's API imposes, shared by the configuration
 * validator and the Admin Panel so a rejected edit is reported as a user error
 * before the file is rewritten.
 */
export function assertModelConfig(api: ProviderApi, model: ModelFileConfig, label: string): void {
  if (model.max_tokens > model.context_window) {
    throw new Error(`${label} max_tokens exceeds context_window`);
  }
  if (!model.reasoning && model.thinking_levels !== undefined) {
    throw new Error(`${label} declares thinking_levels but is not a reasoning model`);
  }
  for (const field of Object.keys(model.compat ?? {})) {
    if (!COMPAT_FIELDS_BY_API[api].includes(field)) {
      throw new Error(`${label} cannot set ${field} for api ${api}`);
    }
  }
}

/**
 * The configured level has to be one the agent model accepts: Pi would otherwise
 * clamp it on some adapters and send it unchanged on others.
 */
function validateAgentThinkingLevel(config: FileConfig, settings: AgentSettings, label: string): void {
  const { provider, model: modelId, thinking_level: level } = settings;
  // An incomplete identity never runs, so there is nothing to check the level
  // against; the file stays loadable instead of rejecting a legal section.
  if (provider === undefined || modelId === undefined || level === undefined) {
    return;
  }
  const model = config.providers[provider]?.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    return;
  }
  const supported = supportedThinkingLevels(model);
  if (!supported.includes(level)) {
    throw new Error(
      `${label}.thinking_level ${level} is not supported by ${provider}/${modelId} (supported: ${supported.join(', ')})`,
    );
  }
}

function validateEndpoint(value: string, label: string, options: { allowQuery?: boolean } = {}): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const invalidQuery = !options.allowQuery && url.search.length > 0;
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    invalidQuery ||
    url.hash
  ) {
    const forbiddenParts = options.allowQuery ? 'credentials or fragment' : 'credentials, query, or fragment';
    throw new Error(`${label} must be an HTTP(S) URL without ${forbiddenParts}`);
  }
}

// A zero-length window can never match, so it is a configuration mistake
// rather than a quiet way to disable one entry.
function validateParticipation(participation: ParticipationConfig | undefined, label: string): void {
  for (const window of participation?.active_windows ?? []) {
    if (window.start === window.end) {
      throw new Error(`${label} has an empty active window: ${window.start}-${window.end}`);
    }
  }
}

/**
 * Conversation Context invariants. `idle_grace_seconds = 0` is the supported way
 * to turn long-lived invocations off, but a grace shorter than one bucket
 * window would look enabled while every run ends before the next bucket is due:
 * a silent degradation, rejected here instead of at 3 a.m. in production.
 */
function validateContextConfig(config: FileConfig, agent: AgentRuntimeConfig): void {
  const context = agent.context;
  if (context.retained_sends_target >= context.retained_sends_max) {
    throw new Error('agent.context.retained_sends_target must be smaller than retained_sends_max');
  }
  if (context.hard_token_ratio > agent.context_stop_ratio) {
    throw new Error('agent.context.hard_token_ratio must not exceed agent.context_stop_ratio');
  }
  if (context.idle_grace_seconds > 0 && context.idle_grace_seconds < config.telegram.bucket_window_seconds) {
    throw new Error(
      'agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_window_seconds',
    );
  }
  if (context.max_wall_clock_seconds <= context.idle_grace_seconds) {
    throw new Error('agent.context.max_wall_clock_seconds must exceed idle_grace_seconds');
  }
}

function validateTimezone(value: string, label: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertUnique<T>(items: readonly T[], select: (item: T) => string, label: string): void {
  const values = new Set<string>();
  for (const item of items) {
    const value = select(item);
    if (values.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    values.add(value);
  }
}
