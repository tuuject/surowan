import { describe, expect, test } from 'vitest';
import { modelsDevProviderId, resolveModelDrafts } from '../../src/platform/models/metadata.ts';
import { catalog, draftOf, openRouterModel } from './metadata-fixtures.ts';

describe('metadata resolution', () => {
  test('reads OpenRouter extended fields and converts per-token prices', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek: DeepSeek V4 Flash',
          context_length: 1310720,
          top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['reasoning', 'include_reasoning'],
          pricing: { prompt: '0.00000004', completion: '0.00000008', input_cache_read: '0.000000016' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.name).toBe('DeepSeek: DeepSeek V4 Flash');
    expect(draft.reasoning).toBe(true);
    expect(draft.input).toEqual(['text']);
    expect(draft.context_window).toBe(1310720);
    expect(draft.max_tokens).toBe(943718);
    expect(draft.cost).toEqual({ input: 0.04, output: 0.08, cache_read: 0.016, cache_write: 0 });
    expect(draft.sources.name).toBe('openrouter');
    expect(draft.sources.cost).toBe('openrouter');
    // models.dev records reasoning_content replay for this id.
    expect(draft.requires_reasoning_content).toBe(true);
    expect(draft.requires_reasoning_content_source).toBe('models.dev');
    // OpenRouter's listing says nothing about effort levels; models.dev does.
    expect(draft.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    expect(draft.sources.thinking_levels).toBe('models.dev');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('keeps thinking levels off a model the listing does not call a reasoning model', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek: DeepSeek V4 Flash',
          context_length: 1048576,
          top_provider: { max_completion_tokens: 384000 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['tools'],
          pricing: { prompt: '0.00000004', completion: '0.00000008' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.reasoning).toBe(false);
    // The configuration rejects levels on a model that does not reason, so the
    // catalog's levels are not carried over.
    expect(draft.thinking_levels).toBeNull();
    expect(draft.sources.thinking_levels).toBe('missing');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('flags a null completion limit as needing confirmation instead of defaulting it', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'rekaai/reka-edge',
          name: 'Reka Edge',
          context_length: 16000,
          top_provider: { max_completion_tokens: null },
          architecture: { input_modalities: ['text'] },
          supported_parameters: [],
          pricing: { prompt: '0.0000001', completion: '0.0000002' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'rekaai/reka-edge');
    expect(draft.max_tokens).toBeNull();
    expect(draft.sources.max_tokens).toBe('missing');
    expect(draft.needs_confirmation).toContain('max_tokens');
    expect(draft.cost).toEqual({ input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 });
  });

  test('fills Gemini metadata from the listing and the rest from models.dev', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        api: 'google-generative-ai',
      },
      [
        {
          id: 'gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          extension: {
            format: 'gemini',
            payload: {
              name: 'models/gemini-3.7-flash',
              displayName: 'Gemini 3.7 Flash',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ['generateContent'],
              thinking: true,
            },
          },
        },
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'gemini-3.7-flash');
    expect(draft.context_window).toBe(1048576);
    expect(draft.max_tokens).toBe(65536);
    expect(draft.reasoning).toBe(true);
    expect(draft.input).toEqual(['text', 'image']);
    expect(draft.sources.input).toBe('models.dev');
    expect(draft.sources.context_window).toBe('gemini');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('only maps the reasoning_content interleaved form', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'moonshotai/kimi-k2.6',
          supported_parameters: ['reasoning'],
          pricing: { prompt: '0.000001' },
        }),
        openRouterModel({ id: 'deepseek/deepseek-v4-pro' }),
      ],
      catalog(),
    );
    // models.dev says `reasoning_details` for kimi-k2.6, which Pi does not model.
    const kimi = draftOf(drafts, 'moonshotai/kimi-k2.6');
    expect(kimi.requires_reasoning_content).toBe(false);
    // The catalog was read but filled nothing in, so no source may claim it.
    expect(kimi.requires_reasoning_content_source).toBe('missing');
    // No models.dev entry at all: stays on automatic detection.
    const pro = draftOf(drafts, 'deepseek/deepseek-v4-pro');
    expect(pro.requires_reasoning_content).toBe(false);
    expect(pro.requires_reasoning_content_source).toBe('missing');
  });

  test('treats the boolean interleaved form as automatic', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'https://ai-gateway.vercel.sh',
        api: 'anthropic-messages',
      },
      [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          extension: {
            format: 'vercel',
            payload: {
              id: 'anthropic/claude-sonnet-4.5',
              name: 'Claude Sonnet 4.5',
              context_window: 1000000,
              max_tokens: 64000,
              type: 'language',
              tags: ['reasoning', 'vision'],
              modalities: { input: ['text', 'image', 'pdf'] },
              pricing: { input: '0.000003', output: '0.000015' },
            },
          },
        },
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'anthropic/claude-sonnet-4.5');
    expect(draft.input).toEqual(['text', 'image']);
    expect(draft.cost).toEqual({ input: 3, output: 15, cache_read: 0, cache_write: 0 });
    expect(draft.sources.cost).toBe('vercel');
    expect(draft.requires_reasoning_content).toBe(false);
    expect(draft.requires_reasoning_content_source).toBe('missing');
  });

  test('falls back to a fuzzy models.dev match and asks to confirm only the key fields', () => {
    const drafts = resolveModelDrafts(
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: '~deepseek-ai/DeepSeek-V3:free', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, '~deepseek-ai/DeepSeek-V3:free');
    expect(draft.match).toEqual({
      provider: 'togetherai',
      model: 'deepseek-ai/DeepSeek-V3',
      confidence: 'fuzzy',
    });
    expect(draft.sources.name).toBe('models.dev-fuzzy');
    expect(draft.sources.reasoning).toBe('models.dev-fuzzy');
    // No deployment of the guessed model is this relay's, so the price is the
    // highest one listed for it — and never asked about.
    expect(draft.cost).toEqual({ input: 0.27, output: 1.1, cache_read: 0, cache_write: 0 });
    expect(draft.sources.cost).toBe('models.dev-highest-price');
    // A guessed model may have other limits: the key fields keep the guessed
    // values, but the admin has to confirm them before the model can be saved.
    expect(draft.context_window).toBe(128000);
    expect(draft.needs_confirmation).toEqual(['input', 'context_window', 'max_tokens']);
    expect(draft.candidates).toEqual([
      { provider: 'togetherai', model: 'deepseek-ai/DeepSeek-V3', confidence: 'fuzzy' },
    ]);
  });

  test('takes the details of a model another provider lists under the same id without asking', () => {
    const drafts = resolveModelDrafts(
      // An unknown relay: the id is exact, so the model is identified even
      // though the catalog entry describes OpenRouter's deployment.
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.match).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      confidence: 'cross-provider',
    });
    expect(draft.context_window).toBe(1048576);
    expect(draft.sources.context_window).toBe('models.dev-cross-provider');
    expect(draft.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    // The relay's own price is unknown: the highest one any deployment lists.
    expect(draft.cost).toEqual({ input: 0.03612, output: 0.07224, cache_read: 0.007224, cache_write: 0 });
    expect(draft.sources.cost).toBe('models.dev-highest-price');
    expect(draft.needs_confirmation).toEqual([]);
    // The same id under the provider the catalog knows is taken as it is.
    const exact = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    expect(draftOf(exact, 'deepseek/deepseek-v4-flash').match).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      confidence: 'exact',
    });
    expect(draftOf(exact, 'deepseek/deepseek-v4-flash').needs_confirmation).toEqual([]);
  });

  test('asks to confirm the input capability when the catalog lists no modalities', () => {
    const noModalities = catalog();
    const entry = noModalities.togetherai?.models['deepseek-ai/DeepSeek-V3'];
    if (entry === undefined) {
      throw new Error('Fixture model is missing');
    }
    delete entry.modalities;
    const drafts = resolveModelDrafts(
      // The exact id is found under another provider, but that listing says
      // nothing about accepted inputs: text-only must not be invented.
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'deepseek-ai/DeepSeek-V3', name: null, extension: { format: 'openai' } }],
      noModalities,
    );
    const draft = draftOf(drafts, 'deepseek-ai/DeepSeek-V3');
    expect(draft.match?.confidence).toBe('cross-provider');
    expect(draft.input).toBeNull();
    expect(draft.sources.input).toBe('missing');
    // The limits are still trusted; only the unknown capability has to be confirmed.
    expect(draft.context_window).toBe(128000);
    expect(draft.sources.context_window).toBe('models.dev-cross-provider');
    expect(draft.needs_confirmation).toEqual(['input']);
  });

  test('asks only for the key fields when no source matches, and defaults the rest', () => {
    const drafts = resolveModelDrafts(
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'unknown-model', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, 'unknown-model');
    expect(draft.name).toBeNull();
    expect(draft.match).toBeNull();
    // Missing levels leave the model on Pi's default, so they block nothing.
    expect(draft.thinking_levels).toBeNull();
    expect(draft.needs_confirmation).toEqual(['input', 'context_window', 'max_tokens']);
    expect(draft.context_window).toBeNull();
    expect(draft.sources.context_window).toBe('missing');
    // Nobody says it thinks: saved as a model that does not, which the panel
    // points out instead of blocking on it.
    expect(draft.reasoning).toBe(false);
    expect(draft.sources.reasoning).toBe('default');
    // Nobody prices it: 0, without asking.
    expect(draft.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(draft.sources.cost).toBe('default');
  });

  test('prices an unmatched provider at the highest price per field across every deployment', () => {
    const withDeepSeek = catalog();
    withDeepSeek.deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      models: {
        'deepseek/deepseek-v4-flash': {
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1048576, output: 384000 },
          cost: { input: 0.05, output: 0.06, cache_read: 0.001, cache_write: 0.02 },
        },
      },
    };
    const relay = resolveModelDrafts(
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      withDeepSeek,
    );
    expect(draftOf(relay, 'deepseek/deepseek-v4-flash').cost).toEqual({
      input: 0.05,
      output: 0.07224,
      cache_read: 0.007224,
      cache_write: 0.02,
    });
    expect(draftOf(relay, 'deepseek/deepseek-v4-flash').sources.cost).toBe('models.dev-highest-price');

    // The provider being configured has its own price, which wins even when a
    // different deployment charges more.
    const own = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      withDeepSeek,
    );
    expect(draftOf(own, 'deepseek/deepseek-v4-flash').cost).toEqual({
      input: 0.03612,
      output: 0.07224,
      cache_read: 0.007224,
      cache_write: 0,
    });
    expect(draftOf(own, 'deepseek/deepseek-v4-flash').sources.cost).toBe('models.dev');
  });

  test('falls back to other deployments when the matched provider lists no price', () => {
    const priced = catalog();
    priced.moonshotai = {
      id: 'moonshotai',
      name: 'Moonshot AI',
      models: {
        'moonshotai/kimi-k2.6': {
          id: 'moonshotai/kimi-k2.6',
          name: 'Kimi K2.6',
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 262144, output: 235929 },
          cost: { input: 0.6, output: 2.5 },
        },
      },
    };
    const openRouter = {
      kind: 'builtin',
      builtinProvider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
    } as const;
    const listing = [{ id: 'moonshotai/kimi-k2.6', name: null, extension: { format: 'openai' } }] as const;
    // OpenRouter's entry for the model carries no price; another deployment does.
    const fallback = draftOf(resolveModelDrafts(openRouter, listing, priced), 'moonshotai/kimi-k2.6');
    expect(fallback.match?.confidence).toBe('exact');
    expect(fallback.cost).toEqual({ input: 0.6, output: 2.5, cache_read: 0, cache_write: 0 });
    expect(fallback.sources.cost).toBe('models.dev-highest-price');
    // Without any deployment that prices it, 0.
    const unpriced = draftOf(resolveModelDrafts(openRouter, listing, catalog()), 'moonshotai/kimi-k2.6');
    expect(unpriced.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(unpriced.sources.cost).toBe('default');
    expect(unpriced.needs_confirmation).toEqual([]);
  });

  test('maps builtin provider ids onto models.dev provider ids', () => {
    expect(
      modelsDevProviderId({
        kind: 'builtin',
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'x',
        api: 'anthropic-messages',
      }),
    ).toBe('vercel');
    expect(
      modelsDevProviderId({ kind: 'custom', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' }),
    ).toBe('openrouter');
    expect(
      modelsDevProviderId({ kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' }),
    ).toBe(null);
  });
});
