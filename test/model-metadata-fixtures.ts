import type { ModelsDevCatalog } from '../src/platform/models-dev.ts';
import type { ModelMetadataDraft } from '../src/platform/model-metadata.ts';
import type { DiscoveredProviderModel } from '../src/platform/provider-models.ts';

/**
 * Synthetic catalogs and listings. Real provider payloads were inspected on
 * 2026-09-20; these fixtures keep only the fields the resolver reads, plus the
 * shapes that make it fail (null output limits, fuzzy ids).
 */
export function catalog(): ModelsDevCatalog {
  const model = (overrides: Record<string, unknown>) =>
    ({
      id: 'x',
      name: 'X',
      reasoning: false,
      modalities: { input: ['text'], output: ['text'] },
      ...overrides,
    }) as ModelsDevCatalog[string]['models'][string];
  return {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      models: {
        'deepseek/deepseek-v4-flash': model({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
          interleaved: { field: 'reasoning_content' },
          limit: { context: 1048576, output: 384000 },
          cost: { input: 0.03612, output: 0.07224, cache_read: 0.007224 },
        }),
        'moonshotai/kimi-k2.6': model({
          id: 'moonshotai/kimi-k2.6',
          name: 'Kimi K2.6',
          reasoning: true,
          interleaved: { field: 'reasoning_details' },
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 262144, output: 235929 },
        }),
      },
    },
    vercel: {
      id: 'vercel',
      name: 'Vercel AI Gateway',
      models: {
        'anthropic/claude-sonnet-4.5': model({
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          reasoning: true,
          interleaved: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 1000000, output: 64000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        }),
      },
    },
    google: {
      id: 'google',
      name: 'Google',
      models: {
        'gemini-3.7-flash': model({
          id: 'gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1048576, output: 65536 },
          cost: { input: 0.3, output: 2.5, cache_read: 0.075, cache_write: 0.3 },
        }),
      },
    },
    togetherai: {
      id: 'togetherai',
      name: 'Together AI',
      models: {
        'deepseek-ai/DeepSeek-V3': model({
          id: 'deepseek-ai/DeepSeek-V3',
          name: 'DeepSeek V3',
          limit: { context: 128000, output: 8192 },
          cost: { input: 0.27, output: 1.1 },
        }),
      },
    },
  };
}

interface OpenRouterFixtureInput {
  readonly id: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly top_provider?: { readonly context_length?: number | null; readonly max_completion_tokens?: number | null };
  readonly architecture?: { readonly input_modalities?: string[] };
  readonly supported_parameters?: string[];
  readonly pricing?: Record<string, string>;
}

export function openRouterModel(input: OpenRouterFixtureInput): DiscoveredProviderModel {
  return {
    id: input.id,
    name: input.name ?? null,
    extension: {
      format: 'openrouter',
      payload: {
        id: input.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.context_length === undefined ? {} : { context_length: input.context_length }),
        ...(input.top_provider === undefined ? {} : { top_provider: input.top_provider }),
        ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
        ...(input.supported_parameters === undefined ? {} : { supported_parameters: input.supported_parameters }),
        ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
      },
    },
  };
}

export function draftOf(drafts: readonly ModelMetadataDraft[], id: string): ModelMetadataDraft {
  const found = drafts.find((draft) => draft.id === id);
  if (found === undefined) {
    throw new Error(`Draft ${id} is missing`);
  }
  return found;
}
