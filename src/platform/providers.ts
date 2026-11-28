import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type OpenAICompletionsCompat,
  type Provider,
  type ProviderAuth,
  type ProviderHeaders,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinModelApi, findBuiltinProvider } from './builtin-providers.ts';
import { deepEqual } from './config/diff-merge.ts';
import type {
  FileConfig,
  ModelCompatConfig,
  ModelFileConfig,
  RawConfig,
  SecretRef,
  ThinkingLevelConfig,
} from './config/index.ts';
import { allConfiguredChats, configuredChats } from './config/index.ts';
import { activeVisionModel, completeAgentSettings, resolveAgentSettings } from './config/resolve.ts';
import type { HostKind } from './im-host/identity.ts';
import type { ConfigurationModels } from './runtime-config.ts';
import type { SecretStore } from './secrets.ts';
import { thinkingLevelMap } from './thinking-levels.ts';

type ProviderFileConfig = FileConfig['providers'][string];

const CUSTOM_ADAPTERS: Record<string, () => ProviderStreams> = {
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};

/**
 * The registry a reload starts from: the file layer the running process was
 * built from, the providers it registered, and a digest of the SecretRef
 * values each provider was built from.
 */
export interface PreviousRegistry {
  readonly file: FileConfig;
  readonly models: Models;
  /** Per-alias connection digest at the time the running provider was built. */
  readonly keyDigests?: Readonly<Record<string, string>>;
}

/**
 * Builds one generation's model registry: one provider object per configured
 * alias, plus the vision model the configuration points at.
 *
 * A provider whose connection fields are unchanged keeps its resolved connection
 * and auth, so credentials are never resolved twice — a `command` SecretRef runs
 * a process, and only an explicitly requested reload of a new or changed
 * connection may have that side effect. A rotation is a change the file does not
 * show: when the previous registry records a different digest for the alias's
 * SecretRefs, the provider is rebuilt too. `previous` is `null` at startup,
 * which builds every provider from the file.
 *
 * Builtin providers keep Pi's base URL, headers and provider-specific logic, but
 * their model list comes from the configuration alone: the catalog decides what
 * may be configured, never what is reachable at runtime.
 */
export async function buildModelRegistry(
  config: RawConfig,
  previous: PreviousRegistry | null,
  secrets: SecretStore,
): Promise<ConfigurationModels> {
  const models = createModels();
  const keyDigests: Record<string, string> = {};
  for (const [alias, configured] of Object.entries(config.providers)) {
    const digest = await connectionKeyDigest(configured, secrets);
    keyDigests[alias] = digest;
    const existing = reusableProvider(previous, alias, configured, digest);
    if (existing !== null) {
      // The model list is built once and closed over, exactly as the provider it
      // replaces did: a lookup must not rebuild the objects on every call.
      const reused = providerModelsFor(alias, configured, existing);
      models.setProvider({ ...existing, getModels: () => reused });
      continue;
    }
    const apiKey = await secrets.resolve(configured.api_key);
    if (configured.kind === 'builtin') {
      const source = findBuiltinProvider(configured.provider);
      if (source === undefined) {
        throw new Error(`Unknown built-in provider: ${configured.provider}`);
      }
      if (source.baseUrl === undefined) {
        throw new Error(`Built-in provider ${configured.provider} has no base URL`);
      }
      models.setProvider(
        aliasBuiltinProvider(alias, source, fixedAuth(alias, apiKey), source.baseUrl, configured.models),
      );
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(configured.headers ?? {})) {
      headers[name] = await secrets.resolve(reference);
    }
    const adapter = CUSTOM_ADAPTERS[configured.api];
    if (adapter === undefined) {
      throw new Error(`Unsupported custom API adapter: ${configured.api}`);
    }
    const baseUrl = configured.base_url.replace(/\/+$/, '');
    models.setProvider(
      createProvider({
        id: alias,
        name: alias,
        baseUrl,
        headers,
        auth: fixedAuth(alias, apiKey),
        api: adapter(),
        models: providerModels(alias, () => configured.api, baseUrl, configured.models, headers),
      }),
    );
  }
  const vision = activeVisionModel(config.vision);
  if (vision === undefined) {
    return { models, visionModel: undefined, keyDigests };
  }
  const visionModel = requireModel(models, vision.provider, vision.model, ['image']);
  if (config.vision.max_output_tokens > visionModel.maxTokens) {
    throw new Error('Vision max_output_tokens exceeds registered model limit');
  }
  return { models, visionModel, keyDigests };
}

/** Selected model/thinking pairs, deduplicated across the default and every Chat. */
export function configuredAgentModels(
  config: RawConfig,
  models: Models,
): { readonly model: Model<Api>; readonly thinkingLevel: ThinkingLevelConfig }[] {
  const selected = [
    resolveAgentSettings(config),
    ...allConfiguredChats(config).map(({ chat }) => resolveAgentSettings(config, chat)),
  ];
  const seen = new Set<string>();
  return selected.flatMap((settings) => {
    // An incomplete identity never reaches the registry: no invocation can
    // start for it, so there is no model to resolve or probe.
    const active = completeAgentSettings(settings);
    if (active === undefined) {
      return [];
    }
    const key = JSON.stringify([active.provider, active.model, active.thinking_level]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        model: requireModel(models, active.provider, active.model, ['text']),
        thinkingLevel: active.thinking_level,
      },
    ];
  });
}

/**
 * The registered models the given configured Chats of one host can run on,
 * restricted to `models` (the configured set) and deduplicated by provider and
 * model id. A Chat without an override follows the global agent settings, so it
 * appears in the global entry as well; only the pair matters here, not the
 * thinking level.
 */
export function modelsForChats(
  config: RawConfig,
  models: readonly Model<Api>[],
  chatIds: readonly number[],
  host: HostKind,
): Model<Api>[] {
  const wanted = new Set(chatIds.map((id) => String(id)));
  const selected: Model<Api>[] = [];
  for (const chat of configuredChats(config, host)) {
    if (!wanted.has(String(chat.id))) {
      continue;
    }
    const active = completeAgentSettings(resolveAgentSettings(config, chat));
    if (active === undefined) {
      continue;
    }
    const model = models.find((candidate) => candidate.provider === active.provider && candidate.id === active.model);
    if (model === undefined) {
      continue;
    }
    if (selected.some((existing) => existing.provider === model.provider && existing.id === model.id)) {
      continue;
    }
    selected.push(model);
  }
  return selected;
}

/**
 * The registered provider to keep for one configured alias, or `null` when the
 * alias has to be built from scratch. The connection digest must match the one
 * the running provider was built from as well: a keychain rotation changes the
 * value without touching the file, and reusing the old connection would keep
 * serving the rotated-away secret.
 */
function reusableProvider(
  previous: PreviousRegistry | null,
  alias: string,
  configured: ProviderFileConfig,
  digest: string,
): Provider | null {
  if (previous === null) {
    return null;
  }
  const previousConfig = previous.file.providers[alias];
  if (previousConfig === undefined || !sameConnection(previousConfig, configured)) {
    return null;
  }
  // Without a recorded digest (a caller that does not track rotations, or the
  // first reload of a process started before this state existed) the file
  // comparison alone decides.
  const recorded = previous.keyDigests?.[alias];
  if (recorded !== undefined && recorded !== digest) {
    return null;
  }
  return previous.models.getProvider(alias) ?? null;
}

/**
 * One digest for a list of SecretRefs, in order; values never leave memory.
 * Each entry is already `SecretStore.digestOf`, so the list itself is the
 * identity: hashing it again would only shorten a string that is compared in
 * memory and never stored.
 */
export async function secretRefsDigest(references: readonly SecretRef[], secrets: SecretStore): Promise<string> {
  const digests: string[] = [];
  for (const reference of references) {
    digests.push(await secrets.digestOf(reference));
  }
  return JSON.stringify(digests);
}

/**
 * One digest for every SecretRef a provider's connection carries. Values under
 * `env` and `command` digest to a constant, so only a keychain rotation can
 * change the result — and checking for one never runs a command.
 */
async function connectionKeyDigest(configured: ProviderFileConfig, secrets: SecretStore): Promise<string> {
  const headerRefs: readonly SecretRef[] = configured.kind === 'custom' ? Object.values(configured.headers ?? {}) : [];
  return await secretRefsDigest([configured.api_key, ...headerRefs], secrets);
}

/**
 * Whether two configurations of one alias describe the same connection:
 * everything the file carries but the enabled model list. Re-kinding a provider
 * counts as a different connection too, since `kind` is part of what is compared.
 */
export function sameConnection(left: ProviderFileConfig, right: ProviderFileConfig): boolean {
  return deepEqual(connectionOf(left), connectionOf(right));
}

/** One provider's connection fields: everything the file carries but `models`. */
function connectionOf(provider: ProviderFileConfig): Record<string, unknown> {
  const connection = { ...provider } as Record<string, unknown>;
  delete connection.models;
  return connection;
}

/** The model list one reused provider serves: same connection, newly enabled models. */
function providerModelsFor(alias: string, configured: ProviderFileConfig, existing: Provider): Model<Api>[] {
  if (configured.kind === 'custom') {
    return providerModels(
      alias,
      () => configured.api,
      existing.baseUrl ?? configured.base_url.replace(/\/+$/, ''),
      configured.models,
      existing.headers,
    );
  }
  const source = findBuiltinProvider(configured.provider);
  if (source === undefined) {
    throw new Error(`Unknown built-in provider: ${configured.provider}`);
  }
  const baseUrl = existing.baseUrl ?? source.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(`Built-in provider ${configured.provider} has no base URL`);
  }
  return builtinConfiguredModels(alias, source, baseUrl, configured.models, existing.headers);
}

/**
 * The configured model list of one builtin alias. pi 1.x catalogs mix chat
 * adapters inside one provider, so each model carries the api of its own
 * catalog entry (unknown ids inherit the uniform catalog api); the forwarded
 * builtin provider dispatches on it.
 */
function builtinConfiguredModels(
  alias: string,
  source: Provider,
  baseUrl: string,
  models: readonly ModelFileConfig[],
  headers?: ProviderHeaders,
): Model<Api>[] {
  return providerModels(
    alias,
    (model) => {
      const api = builtinModelApi(source, model.id);
      if (api === null) {
        throw new Error(
          `Provider ${alias} model ${model.id} has no API adapter in Pi's ${source.id} catalog and the catalog mixes adapters`,
        );
      }
      return api;
    },
    baseUrl,
    models,
    headers,
  );
}

/**
 * The configured model list of one provider. Builtin and custom providers share
 * this mapping: the only difference is where each model's `api` comes from.
 *
 * Pi's completion path reads connection headers from the model rather than the
 * provider, so every model must carry them. Model headers accept strings only;
 * null provider-header entries are omitted.
 */
function providerModels(
  alias: string,
  apiFor: (model: ModelFileConfig) => Api,
  baseUrl: string,
  models: readonly ModelFileConfig[],
  headers?: ProviderHeaders,
): Model<Api>[] {
  let modelHeaders: Record<string, string> | undefined;
  if (headers !== undefined) {
    modelHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== null) {
        modelHeaders[name] = value;
      }
    }
  }
  return models.map((model) => {
    const built: Model<Api> = {
      id: model.id,
      name: model.name ?? model.id,
      api: apiFor(model),
      provider: alias,
      baseUrl,
      ...(modelHeaders !== undefined && Object.keys(modelHeaders).length > 0 ? { headers: modelHeaders } : {}),
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache_read,
        cacheWrite: model.cost.cache_write,
      },
    };
    const levels = thinkingLevelMap(model);
    if (levels !== undefined) {
      built.thinkingLevelMap = levels;
    }
    const compat = model.compat === undefined ? undefined : mapCompat(model.compat);
    return compat === undefined ? built : { ...built, compat };
  });
}

/** The one place that turns the file's snake_case compat into Pi's camelCase. */
export function mapCompat(compat: ModelCompatConfig): NonNullable<Model<Api>['compat']> | undefined {
  const mapped: OpenAICompletionsCompat = {};
  if (compat.supports_developer_role !== undefined) {
    mapped.supportsDeveloperRole = compat.supports_developer_role;
  }
  if (compat.thinking_format !== undefined) {
    mapped.thinkingFormat = compat.thinking_format;
  }
  if (compat.max_tokens_field !== undefined) {
    mapped.maxTokensField = compat.max_tokens_field;
  }
  if (compat.requires_reasoning_content !== undefined) {
    mapped.requiresReasoningContentOnAssistantMessages = compat.requires_reasoning_content;
  }
  if (compat.cache_control_format !== undefined) {
    mapped.cacheControlFormat = compat.cache_control_format;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/**
 * Re-exposes a builtin provider under its configured alias.
 *
 * Requests must keep Pi's own provider id: automatic compat detection keys off
 * it (OpenRouter's cache-control format, DeepSeek's reasoning replay), so the
 * alias is only ever the registry key. Each configured model carries the api of
 * its Pi catalog entry, and the builtin source dispatches on `model.api`.
 */
function aliasBuiltinProvider(
  alias: string,
  source: Provider,
  auth: ProviderAuth,
  baseUrl: string,
  configuredModels: readonly ModelFileConfig[],
): Provider {
  const aliasedModels = builtinConfiguredModels(alias, source, baseUrl, configuredModels, source.headers);
  const fetchDeferred = source.fetchDeferred?.bind(source);
  const cancelDeferred = source.cancelDeferred?.bind(source);
  return {
    id: alias,
    name: source.name,
    baseUrl,
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth,
    getModels: () => aliasedModels,
    stream: (model, context, options) => source.stream({ ...model, provider: source.id }, context, options),
    streamSimple: (model, context, options) => source.streamSimple({ ...model, provider: source.id }, context, options),
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (model, handle, options) => fetchDeferred({ ...model, provider: source.id }, handle, options),
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: (model, handle, options) =>
            cancelDeferred({ ...model, provider: source.id }, handle, options),
        }),
  };
}

function fixedAuth(alias: string, apiKey: string): ProviderAuth {
  return {
    apiKey: {
      name: `${alias} API key`,
      check: async () => ({ type: 'api_key', source: 'configured SecretRef' }),
      resolve: async () => ({ auth: { apiKey }, source: 'configured SecretRef' }),
    },
  };
}

export function requireModel(
  models: Models,
  provider: string,
  modelId: string,
  capabilities: readonly ('text' | 'image')[],
): Model<Api> {
  const model = models.getModel(provider, modelId);
  if (model === undefined) {
    throw new Error(`Model ${provider}/${modelId} is not registered`);
  }
  for (const capability of capabilities) {
    if (!model.input.includes(capability)) {
      throw new Error(`Model ${provider}/${modelId} lacks ${capability} input capability`);
    }
  }
  return model;
}
