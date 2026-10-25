import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { expect, test } from 'vitest';
import { SendInputSchema } from '../../src/capabilities/send/index.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import { ListImageModelsInputSchema } from '../../src/plugins/image/image.ts';
import {
  CUTOFF_AT,
  HISTORY_CAPTION,
  LATE_TEXT,
  OPENING_TEXT,
  SCENE_FIDELITY,
  definition,
  fixture,
  messageText,
  sceneRegistry,
  stablePrompt,
} from './fixtures.ts';

test('a scene replay runs the historical public chat under the current config with synthetic effects and no writes', async () => {
  const contexts: InvocationContext[] = [];
  const f = await fixture({
    definitions: (context) => {
      contexts.push(context);
      return sceneRegistry();
    },
  });
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);

  // The read-only preflight describes the scene without any model request.
  expect(f.runner.inspect(f.seed.invocationA)).toEqual({
    available: true,
    reason: null,
    message: null,
    prompt_overrides_available: true,
    omitted_images: 1,
    fidelity: { ...SCENE_FIDELITY },
    scene: {
      cutoff_at: CUTOFF_AT,
      source_bucket_id: '3001',
      message_count: 2,
      history_count: 1,
      omitted_messages: 0,
    },
  });
  expect(f.runner.prompts(f.seed.invocationA)).toEqual({
    source: 'active',
    source_invocation_id: '4001',
    global_prompt: 'Participate safely.',
    group_prompt: 'private',
    template_values: {
      agent: { provider: 'agent', model: 'agent-model' },
      vision: { provider: 'vision', model: 'vision-model' },
      timezone: 'UTC',
    },
    core_read_only: true,
  });
  expect(f.faux.state.callCount).toBe(0);

  f.faux.setResponses([
    (context, options) => {
      expect(getCurrentSystemPrompt(context.messages)).toBe(stable.systemPrompt);
      // The scene carries the public chat: the bot's own earlier message, the
      // opening batch, a text-only media marker, and nothing past the cutoff or
      // from the internal agent history.
      const scene = messageText(context);
      expect(scene).toContain(HISTORY_CAPTION);
      expect(scene).toContain('media_unavailable');
      expect(scene).toContain(OPENING_TEXT);
      expect(scene).not.toContain(LATE_TEXT);
      expect(scene).not.toContain('private reasoning before calling read');
      expect(scene).not.toContain('trying to answer but the model call failed');
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(
        [
          fauxToolCall('send', { kind: 'text', text: 'synthetic scene send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'synthetic scene memory' } }),
          fauxToolCall('execute', { action: 'call', tool: 'search_stickers', input: {} }),
          fauxToolCall('mcp_remote_write', {}),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private completion'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result).toMatchObject({
    version: 2,
    source_invocation_id: '4001',
    conversation_id: '2001',
    chat_id: '123456789',
    thread_id: '0',
    error: null,
    responded: true,
    send_count: 1,
    completion_reason: 'completed',
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'low' },
    overrides: { global_prompt: false, group_prompt: false },
    usage: { model_calls: 2 },
    fidelity: { ...SCENE_FIDELITY },
  });
  expect(result).not.toHaveProperty('source_model_call_id');
  expect(result.fidelity).not.toHaveProperty('historical_model');
  expect(result.outputs).toEqual([
    expect.objectContaining({
      tool_name: 'send',
      arguments: expect.objectContaining({ text: 'synthetic scene send' }),
    }),
  ]);
  const memoryCall = result.tool_calls.find((call) => JSON.stringify(call.arguments).includes('"add_memory"'));
  expect(memoryCall?.is_error).toBe(false);
  expect(JSON.stringify(memoryCall?.result)).toContain('Saved memory');
  // Sticker search has no scene executor and MCP tools are deny-by-default.
  const stickerCall = result.tool_calls.find((call) => JSON.stringify(call.arguments).includes('"search_stickers"'));
  expect(stickerCall?.is_error).toBe(true);
  const mcpCall = result.tool_calls.find((call) => call.tool_name === 'mcp_remote_write');
  expect(mcpCall?.is_error).toBe(true);
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'blocked', capability: 'search_stickers' }),
      expect.objectContaining({ tool_name: 'mcp_remote_write', mode: 'blocked' }),
    ]),
  );
  expect(f.faux.state.callCount).toBe(2);
  // The tool-definition hook receives the source identity and its config.
  expect(contexts).toHaveLength(3); // inspect, prompts, run each resolve the current registry
  expect(contexts[0]).toMatchObject({
    invocationId: f.seed.invocationA,
    conversationId: f.seed.conversationId,
    chatId: 123_456_789n,
    threadId: 0n,
  });
  // The whole database, production tables included, is untouched.
  expect(f.rows()).toEqual(before);
});

test.each([undefined, false, true])(
  'replay uses the current reply policy (%s) in both descriptions and execution',
  async (allow) => {
    const f = await fixture({
      defaultRegistry: true,
      change: (config) => {
        if (allow !== undefined) {
          config.agent!.allow_reply_message_multiple_times = allow;
        }
      },
    });
    f.faux.setResponses([
      (context) => {
        const send = getCurrentTools(context.messages).find((tool) => tool.name === 'send');
        expect(send?.description.includes('at most one reply')).toBe(allow !== true);
        return fauxAssistantMessage(fauxToolCall('send', { text: 'first', reply_to_message_id: '901' }), {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage(fauxToolCall('send', { text: 'second', reply_to_message_id: '901' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const before = f.rows();
    const result = await f.run();
    expect(result.error).toBeNull();
    expect(result.send_count).toBe(allow === true ? 2 : 1);
    expect(result.tool_calls.map((call) => call.is_error)).toEqual([false, allow !== true]);
    expect(f.rows()).toEqual(before);
  },
);

test.each([false, true])(
  'list_image_models replays validated config without credentials (invalid=%s)',
  async (invalid) => {
    const f = await fixture({
      change: (config) => {
        config.image = {
          credentials: { openrouter: { env: 'OPENROUTER_IMAGE_KEY' } },
          models: [
            {
              id: 'line-art',
              name: 'Line Art',
              description: 'clean line art for stickers',
              provider: 'openrouter',
              upstreamModel: 'org/line-art',
              credentialRef: 'openrouter',
              providerTag: 'art',
              capabilities: {
                imageInput: false,
                maxInputImages: 0,
                maxOutputs: 4,
                aspectRatios: ['1:1', '16:9'],
                resolutionClasses: invalid ? ['unsupported'] : ['auto', 'medium'],
              },
            },
            {
              id: 'anime',
              name: 'Anime',
              provider: 'openrouter',
              upstreamModel: 'org/anime',
              credentialRef: 'openrouter',
              providerTag: 'art',
              capabilities: {
                imageInput: true,
                maxInputImages: 2,
                maxOutputs: 4,
                aspectRatios: ['1:1'],
                resolutionClasses: ['auto'],
              },
            },
          ],
        };
      },
      definitions: () => ({
        tools: [
          definition('read', Type.Object({ uri: Type.String(), base: Type.Optional(Type.String()) })),
          definition('send', SendInputSchema),
          definition('execute'),
          definition('zzz'),
        ],
        capabilities: [definition('list_image_models', ListImageModelsInputSchema)],
      }),
    });
    f.faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall('execute', { action: 'call', tool: 'list_image_models', input: {} })], {
          stopReason: 'toolUse',
        }),
      fauxAssistantMessage('done'),
    ]);
    const before = f.rows();
    const result = await f.run();
    const call = result.tool_calls.find((entry) => JSON.stringify(entry.arguments).includes('"list_image_models"'));
    expect(call?.is_error).toBe(false);
    const body = call?.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const content = body?.content ?? [];
    const envelopeText = content
      .flatMap((entry) => (entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []))
      .join('\n');
    const envelope = JSON.parse(envelopeText) as { text: string };
    const page = JSON.parse(envelope.text) as {
      models: Array<{ id: string; description?: string }>;
      total: number;
      next_offset: number | null;
    };
    // The directory is projected from the current config: descriptions are kept,
    // credentialRef and the resolved credential value never leave the runner.
    if (invalid) {
      expect(page).toEqual({ models: [], total: 0, next_offset: null });
    } else {
      expect(page.total).toBe(2);
      expect(page.models[0]).toMatchObject({ id: 'line-art', description: 'clean line art for stickers' });
      expect(page.models[1]).toMatchObject({ id: 'anime' });
    }
    expect(JSON.stringify(page)).not.toMatch(/credential/i);
    expect(JSON.stringify(page)).not.toContain('OPENROUTER_IMAGE_KEY');
    expect(result.fidelity.dispatches).toContainEqual(
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' }),
    );
    expect(f.faux.state.callCount).toBe(2);
    // The whole database, production tables included, is untouched.
    expect(f.rows()).toEqual(before);
  },
);
