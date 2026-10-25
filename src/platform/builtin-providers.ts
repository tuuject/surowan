import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderApi } from './config/index.ts';

/**
 * The API adapters the configuration supports. Pi ships more (Bedrock, Mistral,
 * Azure, Vertex, …), but the panel and the TUI only ever write these four, and a
 * builtin provider that mixes several of them has no single `api` to record on
 * its configured models.
 */
export const SUPPORTED_PROVIDER_APIS: readonly Api[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

let catalog: readonly Provider[] | undefined;

/** Pi's builtin provider catalog, loaded once per process. */
export function listBuiltinProviders(): readonly Provider[] {
  catalog ??= builtinProviders();
  return catalog;
}

export function findBuiltinProvider(id: string): Provider | undefined {
  return listBuiltinProviders().find((provider) => provider.id === id);
}

/**
 * The one API every chat model in Pi's catalog for this provider speaks, or
 * `null` when the catalog mixes adapters (pi 1.x ships e.g. OpenRouter with
 * both `openai-completions` and `anthropic-messages` chat models).
 */
export function uniformBuiltinApi(source: Provider): Api | null {
  const apis = source.getModels().map((model) => model.api);
  const first = apis[0];
  if (first === undefined || apis.some((api) => api !== first)) {
    return null;
  }
  return first;
}

/**
 * The API one configured model speaks: its Pi catalog entry's adapter, or — for
 * model ids the catalog does not list — the provider's uniform catalog API.
 * `null` means the model cannot be dispatched: an unknown id on a mixed-catalog
 * provider has no adapter to inherit.
 */
export function builtinModelApi(source: Provider, modelId: string): Api | null {
  const entry = findBuiltinModel(source, modelId);
  if (entry !== undefined) {
    return entry.api;
  }
  const uniform = uniformBuiltinApi(source);
  if (uniform !== null) {
    return uniform;
  }
  // A mixed catalog with no entry for the id: the id describes a provider-side
  // gateway model, which speaks the provider's OpenAI-compatible protocol (the
  // one adapter every mixed pi 1.x catalog carries).
  return 'openai-completions';
}

export function isSupportedProviderApi(api: Api): api is ProviderApi {
  return SUPPORTED_PROVIDER_APIS.includes(api);
}

/** `uniformBuiltinApi` narrowed to the adapters the configuration supports. */
export function supportedBuiltinApi(source: Provider): ProviderApi | null {
  const api = uniformBuiltinApi(source);
  return api !== null && isSupportedProviderApi(api) ? api : null;
}

/**
 * Whether a builtin provider may be referenced from the configuration at all:
 * a non-empty catalog, one supported API, a concrete base URL, and API-key auth.
 * OAuth-only providers and placeholder base URLs (`{account}`) cannot be driven
 * from a single configured key, so they are rejected rather than half-supported.
 */
export function isSupportedBuiltinPreset(source: Provider): boolean {
  if (source.getModels().length === 0) {
    return false;
  }
  // The api check is per model (`builtinModelApi`): pi 1.x catalogs mix chat
  // adapters inside one provider, so a preset only needs at least one model the
  // configuration can drive.
  if (!source.getModels().some((model) => isSupportedProviderApi(model.api))) {
    return false;
  }
  if (source.baseUrl === undefined || source.baseUrl.includes('{')) {
    return false;
  }
  return source.auth.apiKey !== undefined;
}

/** Presets the panel may offer, sorted by display name. A preset must speak one API: pi 1.x mixed-catalog providers (OpenRouter, …) stay configurable through an existing alias but are not offered as presets. */
export function listBuiltinPresets(): readonly Provider[] {
  return listBuiltinProviders()
    .filter((source) => isSupportedBuiltinPreset(source) && supportedBuiltinApi(source) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Pi's own catalog entry for one model, when the provider knows it. */
export function findBuiltinModel(source: Provider, modelId: string): Model<Api> | undefined {
  return source.getModels().find((model) => model.id === modelId);
}
