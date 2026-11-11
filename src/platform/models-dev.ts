import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { isThinkingLevel, THINKING_LEVELS } from './thinking-levels.ts';
import { versionUserAgent } from './version.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_MAX_BYTES = 32 * 1024 * 1024;
/** The catalog is a whole-catalog download, so it is cached rather than re-fetched per request. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

const ModelLimitSchema = Type.Object({
  context: Type.Optional(Type.Number()),
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
});

const ModelCostSchema = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cache_read: Type.Optional(Type.Number()),
  cache_write: Type.Optional(Type.Number()),
});

const ModalitiesSchema = Type.Object({
  input: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.Array(Type.String())),
});

/**
 * How a model's reasoning can be controlled: `toggle` switches it on and off,
 * `effort` lists effort values, `budget_tokens` takes a token budget. An empty
 * list means the model always reasons and offers no control.
 */
const ReasoningOptionSchema = Type.Object({
  type: Type.String(),
  values: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Null()]))),
});

/**
 * models.dev records how a provider expects reasoning text to be replayed. The
 * object form names the field the assistant message must carry; the bare
 * boolean form is the older encoding and names nothing, so it cannot be turned
 * into a compat override.
 */
const InterleavedSchema = Type.Union([
  Type.Boolean(),
  Type.Object({ field: Type.Optional(Type.String()) }, { additionalProperties: true }),
]);

const ModelSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.Boolean()),
  reasoning_options: Type.Optional(Type.Array(ReasoningOptionSchema)),
  modalities: Type.Optional(ModalitiesSchema),
  limit: Type.Optional(ModelLimitSchema),
  cost: Type.Optional(ModelCostSchema),
  interleaved: Type.Optional(InterleavedSchema),
});

const ProviderSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  doc: Type.Optional(Type.String()),
  models: Type.Record(Type.String(), ModelSchema),
});

const CatalogSchema = Type.Record(Type.String(), ProviderSchema);
const catalogValidator = Compile(CatalogSchema);

/** Catalog shape as models.dev returns it; `applyDefaults` fills `reasoning` and `modalities`. */
type RawModel = Static<typeof ModelSchema>;
type RawProvider = Static<typeof ProviderSchema>;
type RawCatalog = Static<typeof CatalogSchema>;

export type ModelsDevModel = Omit<RawModel, 'reasoning'> & { reasoning: boolean };
export type ModelsDevProvider = Omit<RawProvider, 'models'> & { models: Record<string, ModelsDevModel> };
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelsDevCatalogOptions {
  readonly url?: string;
  readonly ttlMs?: number;
  /** Test seam: replaced instead of the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function parseCatalog(raw: unknown): RawCatalog {
  if (!catalogValidator.Check(raw)) {
    const error = [...catalogValidator.Errors(raw)][0];
    throw new Error(
      error === undefined
        ? 'models.dev returned an invalid catalog'
        : `models.dev catalog failed validation at ${error.instancePath || '/'}: ${error.message}`,
    );
  }
  return raw;
}

/** Fetches and validates the catalog without any caching. */
export async function fetchModelsDevCatalog(
  url = MODELS_DEV_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelsDevCatalog> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': versionUserAgent() },
    redirect: 'error',
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status} ${response.statusText}`.trim());
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CATALOG_MAX_BYTES) {
    throw new Error(`models.dev catalog exceeds ${CATALOG_MAX_BYTES} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > CATALOG_MAX_BYTES) {
    throw new Error(`models.dev catalog exceeds ${CATALOG_MAX_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error('models.dev returned invalid JSON');
  }
  return applyDefaults(parseCatalog(raw));
}

const cachedCatalogs = new Map<string, { readonly catalog: ModelsDevCatalog; readonly expiresAt: number }>();
const pendingCatalogs = new Map<string, Promise<ModelsDevCatalog>>();

/**
 * Cached catalog accessor. A failure is not cached, and concurrent callers share
 * one request instead of downloading the whole catalog several times.
 *
 * Each address has its own cache entry: `models_dev.api_url` is hot, so a new
 * address has to be read on the very next lookup rather than after the old
 * catalog's TTL runs out, and switching back finds the earlier one still cached.
 * Expired entries are dropped whenever a catalog is stored, which keeps the map
 * as small as the addresses used within one TTL.
 */
export async function loadModelsDevCatalog(options: ModelsDevCatalogOptions = {}): Promise<ModelsDevCatalog> {
  const url = options.url ?? MODELS_DEV_URL;
  const cached = cachedCatalogs.get(url);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.catalog;
  }
  const inFlight = pendingCatalogs.get(url);
  if (inFlight !== undefined) {
    return await inFlight;
  }
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const pending = fetchModelsDevCatalog(url, options.fetchImpl ?? fetch).then((catalog) => {
    const now = Date.now();
    for (const [key, entry] of cachedCatalogs) {
      if (entry.expiresAt <= now) {
        cachedCatalogs.delete(key);
      }
    }
    cachedCatalogs.set(url, { catalog, expiresAt: now + ttlMs });
    return catalog;
  });
  pendingCatalogs.set(url, pending);
  try {
    return await pending;
  } finally {
    pendingCatalogs.delete(url);
  }
}

/** Drops every cached catalog; tests use it to isolate cases. */
export function resetModelsDevCatalogCache(): void {
  cachedCatalogs.clear();
}

/**
 * Fills the `reasoning` field models.dev may omit. Modalities stay exactly as
 * listed: an omitted input list means the catalog does not say which inputs the
 * model accepts, which metadata resolution reports as missing instead of
 * inventing a text-only model.
 */
function applyDefaults(catalog: RawCatalog): ModelsDevCatalog {
  const normalized: ModelsDevCatalog = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      models[modelId] = { ...model, reasoning: model.reasoning ?? false };
    }
    normalized[providerId] = { ...provider, models };
  }
  return normalized;
}

export function findModel(catalog: ModelsDevCatalog, providerId: string, modelId: string): ModelsDevModel | undefined {
  return catalog[providerId]?.models[modelId];
}

export function listProviders(catalog: ModelsDevCatalog): ModelsDevProvider[] {
  return Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name));
}

export function listModels(provider: ModelsDevProvider): ModelsDevModel[] {
  return Object.values(provider.models).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The input capabilities the catalog lists, or `null` when it lists none. A
 * list without any recognized capability still means text only, as before.
 */
export function extractInputCapabilities(model: ModelsDevModel): Array<'text' | 'image'> | null {
  const declared = model.modalities?.input;
  if (declared === undefined) {
    return null;
  }
  const capabilities: Array<'text' | 'image'> = [];
  const inputs = new Set(declared);
  if (inputs.has('text')) {
    capabilities.push('text');
  }
  if (inputs.has('image')) {
    capabilities.push('image');
  }
  if (capabilities.length === 0) {
    capabilities.push('text');
  }
  return capabilities;
}

/** The levels Pi turns into a token budget for a budget-only model. */
const BUDGET_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

/**
 * A model's `reasoning_options` as Pi thinking levels, weakest first, or `null`
 * when the catalog names no level: the model is not a reasoning model, has no
 * options, always reasons without a control (an empty list), or can only be
 * switched on and off. Pi needs a level to switch thinking on, so a bare toggle
 * leaves the choice to Pi's default rather than offering `off` alone.
 *
 * Effort values and budgets define the levels; `off` comes from the effort
 * value `none` or from a toggle, never from a budget — models.dev lists the
 * toggle separately where thinking can be turned off. Values Pi has no level
 * for are dropped.
 */
export function extractThinkingLevels(model: ModelsDevModel): ModelThinkingLevel[] | null {
  if (!model.reasoning || model.reasoning_options === undefined) {
    return null;
  }
  const levels = new Set<ModelThinkingLevel>();
  let toggle = false;
  for (const option of model.reasoning_options) {
    if (option.type === 'toggle') {
      toggle = true;
    } else if (option.type === 'effort') {
      for (const value of option.values ?? []) {
        const level = value === 'none' ? 'off' : value;
        if (level !== null && isThinkingLevel(level)) {
          levels.add(level);
        }
      }
    } else if (option.type === 'budget_tokens') {
      for (const level of BUDGET_THINKING_LEVELS) {
        levels.add(level);
      }
    }
  }
  if ([...levels].every((level) => level === 'off')) {
    return null;
  }
  if (toggle) {
    levels.add('off');
  }
  return THINKING_LEVELS.filter((level) => levels.has(level));
}

export function toModelDefaults(model: ModelsDevModel): {
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  context_window: number;
  max_tokens: number;
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  thinking_levels: ModelThinkingLevel[] | null;
} {
  const limit = model.limit ?? {};
  const cost = model.cost ?? {};
  const contextWindow = limit.context ?? limit.input ?? 0;
  const maxTokens = limit.output ?? 0;
  return {
    name: model.name,
    reasoning: model.reasoning,
    input: extractInputCapabilities(model) ?? ['text'],
    context_window: contextWindow > 0 ? contextWindow : 128000,
    max_tokens: maxTokens > 0 ? maxTokens : 4096,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cache_read: cost.cache_read ?? 0,
      cache_write: cost.cache_write ?? 0,
    },
    thinking_levels: extractThinkingLevels(model),
  };
}
