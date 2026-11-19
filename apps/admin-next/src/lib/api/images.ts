import { ApiError, call, writeHeaders } from './core.ts';
import type { SecretInput, SecretSource } from './keychain.ts';
import type { ModelApplySummary } from './models.ts';

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------
export interface ImageModelInfo {
  readonly id: string;
  readonly name: string;
}

export interface ImageStatus {
  readonly enabled: boolean;
  readonly models: readonly ImageModelInfo[];
}

export interface ImagePromptAsset {
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly description: string;
  readonly category: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ImageAssetInfo {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly description: string;
  readonly category: string;
  /** Searchable tags, one editable text line. */
  readonly keywords: string;
  /** Whether the agent may discover and use this asset; promotion is an admin action. */
  readonly agentVisible: boolean;
  readonly source: 'upload' | 'generation';
  readonly generationId: string | null;
  readonly outputIndex: number | null;
  readonly createdAt: string;
}

export interface ImageGenerationAttempt {
  readonly id: string;
  readonly round: number;
  readonly itemIndex: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly providerRequestId: string | null;
  readonly usage: Record<string, number> | null;
  readonly outputAssetId: string | null;
}

export interface ImageGenerationOutput {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageGenerationRecord {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  readonly source: string;
  readonly actorName: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly snapshot: {
    readonly authored: {
      readonly authoredPrompt: string;
      readonly modelId: string;
      readonly aspectRatio: string;
      readonly resolution: string;
      readonly outputCount: number;
    };
    readonly resolvedPrompt: string;
    readonly finalPrompt: string;
    readonly promptAssets: readonly { readonly id: string; readonly name: string }[];
    readonly imageAssets: readonly { readonly id: string; readonly name: string }[];
  };
  readonly outputs: readonly ImageGenerationOutput[];
  readonly attempts: readonly ImageGenerationAttempt[];
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly replayed?: boolean;
}

export interface ImageSimplePage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ImageSubmitInput {
  readonly prompt: string;
  readonly model_id?: string | undefined;
  readonly aspect_ratio?: string | undefined;
  readonly resolution?: string | undefined;
  readonly output_count?: number | undefined;
  readonly prompt_refs?: readonly string[] | undefined;
  readonly input_image_refs?: readonly string[] | undefined;
  readonly idempotency_key?: string | undefined;
}

export function getImageStatus(): Promise<ImageStatus> {
  return call<ImageStatus>('/image/status');
}

export interface ImageModelConfig {
  id: string;
  name: string;
  provider: string;
  upstreamModel: string;
  credentialRef: string;
  providerTag: string;
  /**
   * Optional notes for the agent's model choice and prompt style (≤1000 chars).
   * Never sent to the upstream image provider.
   */
  description?: string;
  capabilities: {
    imageInput: boolean;
    maxInputImages: number;
    maxOutputs: number;
    aspectRatios: string[];
    resolutionClasses: string[];
  };
}

export interface ImageConfigView {
  revision: string;
  enabled: boolean;
  credentials: string[];
  /** Panel sessions only: where each credential's key comes from, by name. */
  credential_key_sources?: Readonly<Record<string, SecretSource>>;
  models: ImageModelConfig[];
}

export interface ImageCatalogEndpoint {
  id: string;
  providerTag: string;
  providerName: string;
  capabilities: ImageModelConfig['capabilities'];
  unavailableReason: string | null;
}

export function getImageConfig(): Promise<ImageConfigView> {
  return call('/image/config');
}

export function getImageModelCatalog(): Promise<{ models: { id: string; name: string }[] }> {
  return call('/image/models');
}

export function getImageModelEndpoints(model: string): Promise<{ endpoints: ImageCatalogEndpoint[] }> {
  return call(`/image/models/endpoints?${new URLSearchParams({ model })}`);
}

export function listImagePrompts(
  filters: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImagePromptAsset>> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set('q', filters.q);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/prompts?${params.toString()}`);
}

export function createImagePrompt(body: {
  name: string;
  body: string;
  description?: string;
  category?: string;
}): Promise<ImagePromptAsset> {
  return call('/image/prompts', { method: 'POST', body: JSON.stringify(body) });
}

export function updateImagePrompt(
  id: string,
  body: { name?: string; body?: string; description?: string; category?: string },
): Promise<ImagePromptAsset> {
  return call(`/image/prompts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function archiveImagePrompt(id: string): Promise<{ status: string }> {
  return call(`/image/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listImageAssets(
  filters: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImageAssetInfo>> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set('q', filters.q);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/images?${params.toString()}`);
}

export function uploadImageAsset(body: {
  name: string;
  base64: string;
  mime: string;
  description?: string;
  category?: string;
}): Promise<ImageAssetInfo> {
  return call('/image/images', { method: 'POST', body: JSON.stringify(body) });
}

export function updateImageAsset(
  id: string,
  body: { name?: string; description?: string; category?: string; keywords?: string; agentVisible?: boolean },
): Promise<ImageAssetInfo> {
  return call(`/image/images/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function getImageAsset(id: string): Promise<ImageAssetInfo> {
  return call(`/image/images/${encodeURIComponent(id)}`);
}

/** One image-capable configured model the one-off extraction picker lists. */
export interface ExtractionModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly thinking_levels: readonly string[];
}

/** `tool_model_no_image_input`: the response carries the models the picker may use instead. */
export class ToolModelNoImageInputError extends Error {
  readonly models: readonly ExtractionModelOption[];

  constructor(models: readonly ExtractionModelOption[], message: string) {
    super(message);
    this.models = models;
    this.name = 'ToolModelNoImageInputError';
  }
}

export interface ExtractedAssetMetadata {
  readonly name: string;
  readonly keywords: readonly string[];
}

/**
 * The two-step extraction preview: a model looks at one asset and proposes a
 * name and keywords. Nothing is saved; the caller fills its edit dialog. The
 * optional one-off model is validated server-side and never persisted.
 */
export async function extractImageAsset(
  id: string,
  model?: { readonly provider: string; readonly model: string; readonly thinking_level: string },
): Promise<ExtractedAssetMetadata> {
  try {
    return await call<ExtractedAssetMetadata>(`/image/images/${encodeURIComponent(id)}/extract`, {
      method: 'POST',
      ...(model === undefined ? { body: JSON.stringify({}) } : { body: JSON.stringify({ model }) }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'tool_model_no_image_input') {
      const body = error.payload as { message?: unknown; models?: unknown } | null;
      const listed = body?.models;
      const models = Array.isArray(listed)
        ? (listed as ExtractionModelOption[]).filter(
            (option) =>
              typeof option?.provider === 'string' &&
              typeof option?.model === 'string' &&
              typeof option?.name === 'string' &&
              Array.isArray(option.thinking_levels),
          )
        : [];
      throw new ToolModelNoImageInputError(models, error.message);
    }
    throw error;
  }
}

export function archiveImageAsset(id: string): Promise<{ status: string }> {
  return call(`/image/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function imageUrl(assetId: string): string {
  return `/api/image/images/${encodeURIComponent(assetId)}/content`;
}

export function listImageGenerations(
  filters: { readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImageGenerationRecord>> {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/generations?${params.toString()}`);
}

export function getImageGeneration(id: string): Promise<ImageGenerationRecord> {
  return call(`/image/generations/${encodeURIComponent(id)}`);
}

export function submitImageGeneration(
  input: ImageSubmitInput,
): Promise<{ generation: ImageGenerationRecord; replayed: boolean }> {
  return call('/image/generations', { method: 'POST', body: JSON.stringify(input) });
}

export function resolveImageGeneration(input: ImageSubmitInput): Promise<Record<string, unknown>> {
  return call('/image/generations/resolve', { method: 'POST', body: JSON.stringify(input) });
}

export function retryImageGeneration(id: string): Promise<{ generation: ImageGenerationRecord; replayed: boolean }> {
  return call(`/image/generations/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ idempotency_key: `retry-${Date.now()}` }),
  });
}

export function putImageConfig(
  body: { enabled: boolean; credentials?: Record<string, SecretInput | null>; models?: ImageModelConfig[] },
  revision: string,
): Promise<{ enabled: boolean; apply: ModelApplySummary }> {
  return call('/image/config', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
