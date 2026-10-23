import { call, writeHeaders } from './core.ts';
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
  readonly created_at: string;
  readonly updated_at: string;
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
  readonly source: 'upload' | 'generation';
  readonly generation_id: string | null;
  readonly output_index: number | null;
  readonly created_at: string;
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
  credential_providers: string[];
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
  body: { name?: string; description?: string; category?: string },
): Promise<ImageAssetInfo> {
  return call(`/image/images/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
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
  body: { enabled: boolean; credentials?: Record<string, string>; models?: ImageModelConfig[] },
  revision: string,
): Promise<{ enabled: boolean; apply: ModelApplySummary }> {
  return call('/image/config', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
