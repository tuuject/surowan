import { describe, expect, test } from 'vitest';

import { modelFormFromConfig, modelFormToConfig, modelFromDraft } from './model-manager.ts';
import type { ModelMetadataDraft, ProviderModelConfig } from './api/providers.ts';

function draft(overrides: Partial<ModelMetadataDraft> = {}): ModelMetadataDraft {
  return {
    id: 'vendor/model',
    name: 'Model',
    reasoning: true,
    thinking_levels: null,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    requires_reasoning_content: false,
    sources: {
      name: 'openrouter',
      reasoning: 'openrouter',
      thinking_levels: 'missing',
      input: 'openrouter',
      context_window: 'openrouter',
      max_tokens: 'openrouter',
      cost: 'openrouter',
    },
    requires_reasoning_content_source: 'models.dev',
    match: null,
    candidates: [],
    needs_confirmation: [],
    ...overrides,
  };
}

describe('model form conversion', () => {
  test('a draft with a null limit never produces a silently defaulted model', () => {
    expect(modelFromDraft(draft({ max_tokens: null }))).toBeUndefined();
    expect(modelFromDraft(draft({ cost: null }))).toBeUndefined();
    expect(modelFromDraft(draft({ input: null }))).toBeUndefined();
  });

  test('a stored tool-schema profile survives the form round trip', () => {
    const config: ProviderModelConfig = {
      id: 'qwen/qwen3.8-27b:free',
      name: 'Qwen',
      reasoning: true,
      tool_schema_keywords: 'minimal',
      input: ['text', 'image'],
      context_window: 262_144,
      max_tokens: 235_929,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    };
    const form = modelFormFromConfig(config, 'openai-completions');
    expect(modelFormToConfig(form, 'openai-completions')).toMatchObject({ tool_schema_keywords: 'minimal' });
  });
});
