import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderApi } from './config/index.ts';

/**
 * The API adapters the configuration supports, in mixed-catalog priority order:
 * a provider whose catalog speaks several of them records the first one it
 * lists (`preferredBuiltinApi`). Pi ships more (Bedrock, Mistral, Azure,
 * Vertex, …), but the panel and the TUI only ever write these four.
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
 * The API a preset records for a provider whose catalog mixes adapters: the
 * first supported API — in `SUPPORTED_PROVIDER_APIS` order, `openai-completions`
 * first — the catalog contains. `null` when no supported adapter appears at all
 * (`isSupportedBuiltinPreset` already rejects those). Each configured model is
 * still dispatched with the api of its own catalog entry, not this one.
 */
export function preferredBuiltinApi(source: Provider): ProviderApi | null {
  for (const candidate of SUPPORTED_PROVIDER_APIS) {
    if (isSupportedProviderApi(candidate) && source.getModels().some((model) => model.api === candidate)) {
      return candidate;
    }
  }
  return null;
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

/**
 * Coding / agent subscription plans. Their terms cover interactive use inside
 * coding or agent tools, and some forbid backend or scripted calls outright; a
 * bot answering group traffic all day is neither, so offering them as presets
 * would invite account bans. They are only kept out of the add-provider menu:
 * an alias already in the configuration still loads, edits and runs.
 * Pi's `zai` is listed because its base URL is the GLM Coding Plan endpoint,
 * and `github-copilot` because its catalog mixes supported adapters, so the
 * preferred-api rule would otherwise put a Copilot plan on the preset menu.
 */
const SUBSCRIPTION_PLAN_PROVIDERS: ReadonlySet<string> = new Set([
  'github-copilot',
  'kimi-coding',
  'zai',
  'zai-coding-cn',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
]);

/** Presets the panel may offer, sorted by display name. A preset records the first supported API the catalog contains (`preferredBuiltinApi`), so pi 1.x mixed-catalog providers like OpenRouter are offered too, while every configured model still dispatches with its own catalog api. Subscription plans are never offered. */
export function listBuiltinPresets(): readonly Provider[] {
  return listBuiltinProviders()
    .filter(
      (source) =>
        !SUBSCRIPTION_PLAN_PROVIDERS.has(source.id) &&
        isSupportedBuiltinPreset(source) &&
        preferredBuiltinApi(source) !== null,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Pi's own catalog entry for one model, when the provider knows it. */
export function findBuiltinModel(source: Provider, modelId: string): Model<Api> | undefined {
  return source.getModels().find((model) => model.id === modelId);
}
