import { call, writeHeaders } from './core.ts';
import type { ModelSwitchRequest, ThinkingLevel } from './models.ts';
import type { ToolModelView } from './tools.ts';

/** The four adapters the configuration supports; anything else is rejected. */
export const PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

export type ProviderKind = 'builtin' | 'custom';

export type ModelInput = 'text' | 'image';

/**
 * Where one metadata field of a model draft came from. The two qualified
 * models.dev sources are guesses: the id was found under another provider, or
 * only after normalizing it.
 */
export type MetadataSource =
  | 'openrouter'
  | 'vercel'
  | 'gemini'
  | 'models.dev'
  | 'models.dev-cross-provider'
  | 'models.dev-fuzzy'
  | 'missing';

/** How far the models.dev lookup had to reach for a draft. */
export type ModelsDevConfidence = 'exact' | 'cross-provider' | 'fuzzy';

export interface ModelsDevMatch {
  readonly provider: string;
  readonly model: string;
  readonly confidence: ModelsDevConfidence;
}

export type DraftField = 'name' | 'reasoning' | 'thinking_levels' | 'input' | 'context_window' | 'max_tokens' | 'cost';

export type ThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'string-thinking';

export interface ModelCostConfig {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** Selected Pi compat overrides; an absent field leaves Pi's own detection in charge. */
export interface ModelCompatConfig {
  readonly supports_developer_role?: boolean;
  readonly thinking_format?: ThinkingFormat;
  readonly max_tokens_field?: 'max_completion_tokens' | 'max_tokens';
  readonly requires_reasoning_content?: boolean;
  readonly cache_control_format?: 'anthropic';
}

/** A model as it is stored in config.jsonc. */
export interface ProviderModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly reasoning: boolean;
  /** Reasoning models only; absent means Pi's default (`off` through `high`). */
  readonly thinking_levels?: readonly ThinkingLevel[];
  readonly compat?: ModelCompatConfig;
  /**
   * Which JSON Schema keywords this model's tool definitions may carry; absent
   * sends every keyword the runtime builds.
   */
  readonly tool_schema_keywords?: 'minimal';
  readonly input: readonly ModelInput[];
  readonly context_window: number;
  readonly max_tokens: number;
  readonly cost: ModelCostConfig;
}

export interface ProviderView {
  readonly alias: string;
  readonly kind: ProviderKind;
  /** Pi's provider id; present on builtin providers only. */
  readonly provider?: string;
  readonly api: ProviderApi;
  readonly base_url: string;
  /** Header names only; the values never leave the process. */
  readonly header_names: readonly string[];
  readonly models: readonly ProviderModelConfig[];
}

export interface ProviderModelReference {
  readonly provider: string;
  readonly model: string;
}

export interface AgentModelReference {
  /** Null when the identity triple is not (fully) configured: no invocation can start. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: ThinkingLevel | null;
}

export interface VisionModelReference {
  /** Null when no vision model is configured: read_image and sticker indexing are unavailable. */
  readonly provider: string | null;
  readonly model: string | null;
}

export interface ProvidersView {
  /** SHA-256 of config.jsonc; every write has to echo it back via `If-Match`. */
  readonly revision: string;
  /** Whether the deployment declares an external supervisor that restarts `serve`. */
  readonly supervised: boolean;
  readonly agent: AgentModelReference;
  readonly vision: VisionModelReference;
  /**
   * The system-wide auxiliary model. `inherited` means no dedicated config
   * exists and `provider`/`model`/`thinking_level` describe the global agent
   * settings it follows.
   */
  readonly tool_model: ToolModelView;
  /** Config paths whose new value is on disk but not live yet. */
  readonly restart_required: readonly string[];
  readonly providers: readonly ProviderView[];
}

export interface ProviderPresetView {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly base_url: string;
}

export interface ModelMetadataDraft {
  readonly id: string;
  readonly name: string | null;
  readonly reasoning: boolean | null;
  /** Only ever set on a reasoning model; `null` leaves the model on Pi's default. */
  readonly thinking_levels: readonly ThinkingLevel[] | null;
  readonly input: readonly ModelInput[] | null;
  readonly context_window: number | null;
  readonly max_tokens: number | null;
  readonly cost: ModelCostConfig | null;
  /** `true` only when models.dev records that reasoning content must be replayed. */
  readonly requires_reasoning_content: boolean;
  readonly sources: Readonly<Record<DraftField, MetadataSource>>;
  readonly requires_reasoning_content_source: MetadataSource;
  readonly match: ModelsDevMatch | null;
  readonly candidates: readonly ModelsDevMatch[];
  /** Fields the admin has to fill or confirm before the model may be saved. */
  readonly needs_confirmation: readonly DraftField[];
}

export interface DiscoveredModel extends ModelMetadataDraft {
  readonly configured: boolean;
}

export interface DiscoverResponse {
  readonly endpoint: string;
  readonly models: readonly DiscoveredModel[];
  /**
   * Set when models.dev could not be fetched: the listing is still usable, but
   * every field only that catalog could have filled needs manual confirmation.
   */
  readonly metadata_source_error: string | null;
}

export interface LookupMetadataResponse {
  readonly models: readonly ModelMetadataDraft[];
  readonly metadata_source_error: string | null;
}

export interface ProviderApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
}

/** Every provider write answers with the refreshed view plus what the apply did. */
export interface ProviderWriteResponse extends ProvidersView {
  readonly apply: ProviderApplySummary;
}

export interface CreateProviderRequest {
  readonly alias: string;
  readonly kind: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly ProviderModelConfig[];
}

/** Omitted fields keep their stored value; `null` header values delete the header. */
export interface UpdateProviderRequest {
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
}

export interface DiscoverRequest {
  readonly alias?: string;
  readonly kind?: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LookupMetadataRequest {
  readonly kind: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly ids: readonly string[];
}

export function getProviders(): Promise<ProvidersView> {
  return call<ProvidersView>('/providers');
}

export function getProviderPresets(): Promise<{ readonly presets: readonly ProviderPresetView[] }> {
  return call<{ readonly presets: readonly ProviderPresetView[] }>('/provider-presets');
}

export function createProvider(body: CreateProviderRequest, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/providers', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateProvider(
  alias: string,
  body: UpdateProviderRequest,
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function deleteProvider(alias: string, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export function appendProviderModels(
  alias: string,
  models: readonly ProviderModelConfig[],
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models`, {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify({ models }),
  });
}

/** Model ids may contain `/`, so the path segment has to stay percent-encoded. */
export function replaceProviderModel(
  alias: string,
  modelId: string,
  model: ProviderModelConfig,
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(model),
  });
}

export function deleteProviderModel(alias: string, modelId: string, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models/${encodeURIComponent(modelId)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

/** Discovery and metadata lookup write nothing and therefore need no revision. */
export function discoverProviderModels(body: DiscoverRequest): Promise<DiscoverResponse> {
  return call<DiscoverResponse>('/providers/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function lookupModelMetadata(body: LookupMetadataRequest): Promise<LookupMetadataResponse> {
  return call<LookupMetadataResponse>('/providers/lookup-metadata', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type HealthCheckStatus = 'ok' | 'unexpected_response' | 'error';

export interface HealthCheckResult {
  readonly provider: string;
  readonly model: string;
  readonly status: HealthCheckStatus;
  /** Time until HTTP response headers, not a generated token; null without an adapter hook. */
  readonly ttfb_ms: number | null;
  readonly duration_ms: number;
  readonly response_text: string;
  readonly error: string | null;
}

/**
 * One real model call with the fixed probe prompt; provider charges may apply.
 * Read-only probe, so it needs no revision. Upstream failures come back as
 * `status: 'error'` in a 200; validation and HTTP errors throw like any call.
 */
export function healthCheckProviderModel(request: ModelSwitchRequest, signal: AbortSignal): Promise<HealthCheckResult> {
  return call<HealthCheckResult>('/providers/health-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
}
