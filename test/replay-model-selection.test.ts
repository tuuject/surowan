import {
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import Type from 'typebox';
import { expect, test } from 'vitest';
import type { ReplayPromptOverrides } from '../src/orchestration/replay.ts';
import { definition, fixture, messageText, sceneRegistry } from './replay-fixtures.ts';

/**
 * A second provider (`alt`) with a reasoning text+image model, registered next
 * to the default agent faux. The scene prompt names the current model so the
 * test can prove the selected model drives the rendered template values.
 */
function crossProviderFixture() {
  let altFaux: FauxProviderHandle | undefined;
  let clipFaux: FauxProviderHandle | undefined;
  const f = fixture({
    systemPrompt: 'Current model {{agent.provider}}/{{agent.model}}.',
    change: (config) => {
      config.providers.alt = {
        kind: 'custom',
        base_url: 'https://example.test/alt/v1',
        api: 'openai-responses',
        api_key: { jar: 'alt' },
        models: [
          {
            id: 'alt-model',
            name: 'Alt Model',
            reasoning: true,
            input: ['text', 'image'],
            context_window: 200_000,
            max_tokens: 64,
            cost: { input: 2, output: 3, cache_read: 0.2, cache_write: 2 },
          },
        ],
      };
      config.providers.clip = {
        kind: 'custom',
        base_url: 'https://example.test/clip/v1',
        api: 'openai-responses',
        api_key: { jar: 'clip' },
        models: [
          {
            id: 'clip-model',
            reasoning: false,
            input: ['image'],
            context_window: 8_000,
            max_tokens: 100,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    },
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [
        ...sceneRegistry().capabilities,
        definition('read_image', Type.Object({ image_ref: Type.String() }, { additionalProperties: false })),
      ],
    }),
    imageLoader: async (_id, signal) => {
      signal.throwIfAborted();
      return { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    },
    registry: (agentFaux) => {
      altFaux = fauxProvider({
        provider: 'alt',
        models: [
          {
            id: 'alt-model',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200_000,
            maxTokens: 64,
            cost: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 },
          },
        ],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      clipFaux = fauxProvider({
        provider: 'clip',
        models: [{ id: 'clip-model', reasoning: false, input: ['image'], contextWindow: 8_000, maxTokens: 100 }],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      const models = createModels();
      models.setProvider(agentFaux.provider);
      models.setProvider(altFaux.provider);
      models.setProvider(clipFaux.provider);
      return { registry: { models, visionModel: agentFaux.getModel() }, extra: [altFaux, clipFaux] };
    },
  });
  return { promise: f, altFaux: () => altFaux };
}

test('an explicit cross-provider model pair drives prompt, image, budget, cost and provider connection', async () => {
  const { promise, altFaux } = crossProviderFixture();
  const f = await promise;
  const alt = altFaux();
  if (alt === undefined) {
    throw new Error('alt faux provider was not built');
  }
  const before = f.rows();

  // The free preflight discloses the resolved target and its weakest level.
  const preflight = f.runner.inspect(f.seed.invocationA, { provider: 'alt', model: 'alt-model' });
  expect(preflight).toMatchObject({
    available: true,
    fidelity: { model_selection: 'temporary_override' },
    model: { provider: 'alt', id: 'alt-model', thinking_level: 'off' },
  });
  expect(preflight.scene?.omitted_messages).toBe(0);

  alt.setResponses([
    (context, options, _state, model) => {
      // Prompt variables render the selected model, not the Chat settings.
      expect(getCurrentSystemPrompt(context.messages)).toContain('Current model alt/alt-model.');
      // The selected model's image capability turns the scene media into refs.
      expect(messageText(context)).toMatch(/img_[a-f0-9]+/);
      // The scene budget is the target's maxTokens and the target's provider
      // object is the one that streams, carrying the target's own cost rates.
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 64 });
      expect(model).toMatchObject({ id: 'alt-model', provider: 'alt', reasoning: true });
      expect(model.cost.input).toBe(2);
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'alt selected send' }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('alt done'),
  ]);
  const result = await f.run({ provider: 'alt', model: 'alt-model' });
  expect(result).toMatchObject({
    error: null,
    send_count: 1,
    model: { provider: 'alt', id: 'alt-model', thinking_level: 'off' },
    overrides: { global_prompt: false, group_prompt: false, provider: true, model: true, thinking_level: false },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.faux.state.callCount).toBe(0);
  expect(alt.state.callCount).toBe(2);
  expect(f.rows()).toEqual(before);

  // The same scene fails on a target with a smaller window: the context
  // budget follows the selected model before any request is made.
  const tiny = await fixture({
    change: (config) => {
      config.providers.tiny = {
        kind: 'custom',
        base_url: 'https://example.test/tiny/v1',
        api: 'openai-responses',
        api_key: { jar: 'tiny' },
        models: [
          {
            id: 'tiny-model',
            reasoning: false,
            input: ['text'],
            context_window: 256,
            max_tokens: 64,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    },
    registry: (agentFaux) => {
      const tinyFaux = fauxProvider({
        provider: 'tiny',
        models: [{ id: 'tiny-model', reasoning: false, input: ['text'], contextWindow: 256, maxTokens: 64 }],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      const models = createModels();
      models.setProvider(agentFaux.provider);
      models.setProvider(tinyFaux.provider);
      return { registry: { models, visionModel: agentFaux.getModel() }, extra: [tinyFaux] };
    },
  });
  expect(await tiny.run({ provider: 'tiny', model: 'tiny-model' })).toMatchObject({
    error: { code: 'context_limit' },
    usage: { model_calls: 0 },
  });
  expect(tiny.faux.state.callCount).toBe(0);
});

test('unknown targets, missing text capability and unsupported thinking levels are rejected before any request', async () => {
  const { promise, altFaux } = crossProviderFixture();
  const f = await promise;
  const alt = altFaux();
  if (alt === undefined) {
    throw new Error('alt faux provider was not built');
  }
  const cases: readonly [ReplayPromptOverrides, string, string][] = [
    [{ provider: 'nope', model: 'x' }, 'unknown_provider', 'Provider nope is not configured'],
    [{ provider: 'agent', model: 'nope' }, 'unknown_model', 'Model agent/nope is not registered'],
    // The vision alias exists in the config but its models are not registered.
    [{ provider: 'vision', model: 'vision-model' }, 'unknown_model', 'Model vision/vision-model is not registered'],
    // The clip model is registered but takes only image input: no text scene.
    [{ provider: 'clip', model: 'clip-model' }, 'not_text_capable', 'Model clip/clip-model does not accept text input'],
    [{ provider: 'alt', model: 'alt-model', thinking_level: 'xhigh' }, 'replay_thinking_level_unsupported', ''],
    [{ thinking_level: 'xhigh' }, 'replay_thinking_level_unsupported', ''],
    [{ thinking_level: 'banana' as unknown as ModelThinkingLevel }, 'replay_thinking_level_invalid', ''],
    [{ provider: 'alt' }, 'replay_model_pair_required', 'provider and model must be provided together'],
    [{ model: 'alt-model' }, 'replay_model_pair_required', 'provider and model must be provided together'],
  ];
  for (const [selection, code, message] of cases) {
    // The read-only preflight reports the same engine rejection as a document;
    // the run throws it before any model request.
    const preflight = f.runner.inspect(f.seed.invocationA, selection);
    expect(preflight).toMatchObject({
      available: false,
      reason: code,
      fidelity: { model_selection: 'temporary_override' },
    });
    if (message.length > 0) {
      expect(preflight.message).toBe(message);
    }
    await expect(f.run(selection)).rejects.toMatchObject({ code, status: 400 });
  }
  expect(f.faux.state.callCount).toBe(0);
  expect(alt.state.callCount).toBe(0);
});

test('an explicit same-model pair resets thinking to the weakest level and a standalone level must be supported', async () => {
  const f = await fixture();
  // Current chat settings: agent/agent-model at 'low'; the faux model does not
  // reason, so its only supported level is 'off'.
  const preflight = f.runner.inspect(f.seed.invocationA, { provider: 'agent', model: 'agent-model' });
  expect(preflight).toMatchObject({
    available: true,
    fidelity: { model_selection: 'temporary_override' },
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
  });

  f.faux.setResponses([fauxAssistantMessage('same model reset')]);
  const before = f.rows();
  const result = await f.run({ provider: 'agent', model: 'agent-model' });
  expect(result).toMatchObject({
    error: null,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    overrides: { global_prompt: false, group_prompt: false, provider: true, model: true, thinking_level: false },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.faux.state.callCount).toBe(1);
  expect(f.rows()).toEqual(before);

  // A standalone thinking override is still a temporary selection, even
  // though the provider/model pair remains unchanged.
  f.faux.setResponses([fauxAssistantMessage('standalone level')]);
  const standalone = await f.run({ thinking_level: 'off' });
  expect(standalone).toMatchObject({
    error: null,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    overrides: { provider: false, model: false, thinking_level: true },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.runner.inspect(f.seed.invocationA, { thinking_level: 'off' })).toMatchObject({
    available: true,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    fidelity: { model_selection: 'temporary_override' },
  });
  await expect(f.run({ thinking_level: 'low' })).rejects.toMatchObject({ code: 'replay_thinking_level_unsupported' });
  expect(f.faux.state.callCount).toBe(2);
});
