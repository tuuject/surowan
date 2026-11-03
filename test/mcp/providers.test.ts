import { fauxAssistantMessage, fauxToolCall, normalizeContext } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { loadToolImages, projectCompletionsToolImages } from '../../src/capabilities/media/tool-images.ts';
import { buildModelRegistry } from '../../src/platform/providers.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { scrubModelRequestAuditJson } from '../../src/platform/models/request-audit.ts';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';
import { appendImageResult, imageFixture } from './image-fixtures.ts';

for (const [api, modelId] of [
  ['openai-completions', 'image-model'],
  ['openai-responses', 'image-model'],
  ['anthropic-messages', 'claude-sonnet-4'],
  ['google-generative-ai', 'gemini-3-flash'],
  ['google-generative-ai', 'gemini-2.5-flash'],
] as const) {
  test(`${api}/${modelId} sends attributed tool pixels through the real adapter and scrubs audit`, async () => {
    const f = await imageFixture();
    let body: unknown;
    const http = await startFixtureServer(async (request) => {
      body = await request.json();
      return Response.json(
        { error: { message: 'fixture stops after receiving payload', code: 400, status: 'INVALID_ARGUMENT' } },
        { status: 400 },
      );
    });
    try {
      const configured = f.loaded.config.providers.agent;
      if (configured?.kind !== 'custom') {
        throw new Error('Missing custom provider');
      }
      const registry = await buildModelRegistry(
        {
          ...f.loaded.config,
          providers: {
            ...f.loaded.config.providers,
            agent: {
              ...configured,
              api,
              base_url: `http://127.0.0.1:${http.port}`,
              models: configured.models.map((model) => ({
                ...model,
                id: modelId,
                reasoning: false,
                input: ['text', 'image'],
              })),
            },
          },
        },
        null,
        new SecretStore(keyJarPath(f.loaded.configPath)),
      );
      const model = registry.models.getModel('agent', modelId)!;
      const first = appendImageResult(f, await f.tool.execute('call_a|item_a', {}), 'call_a|item_a');
      const second = appendImageResult(f, await f.tool.execute('call_b', { error: true }), 'call_b');
      const assistant = fauxAssistantMessage(
        [
          fauxToolCall('local__images', {}, { id: first.toolCallId }),
          fauxToolCall('local__images', { error: true }, { id: second.toolCallId }),
        ],
        { stopReason: 'toolUse' },
      );
      const hydrated = await loadToolImages([assistant, first, second], {
        orm: f.store.orm,
        dataDir: f.loaded.config.data_dir,
        conversationId: f.seed.conversationId,
        chatId: f.seed.chatId,
        model,
        signal: new AbortController().signal,
      });
      const messages = api === 'openai-completions' ? projectCompletionsToolImages(hydrated) : hydrated;
      await registry.models.streamSimple(model, normalizeContext({ messages }), { maxRetries: 0 }).result();
      expect(body).toBeDefined();
      const encoded = JSON.stringify(body);
      for (const message of hydrated) {
        if (message.role === 'toolResult') {
          for (const block of message.content) {
            if (block.type === 'image') {
              expect(encoded).toContain(block.data);
            }
          }
        }
      }
      expect(encoded).toContain('call_b');
      expect(encoded).toContain('local__images');
      expect(encoded).toContain('isError=true');
      if (api === 'openai-completions') {
        const request = body as { messages: { role: string; content: unknown; tool_call_id?: string }[] };
        const tools = request.messages.filter((message) => message.role === 'tool');
        expect(tools).toHaveLength(2);
        expect(tools[0]?.tool_call_id).toBe('call_a_item_a');
        const user = request.messages.find((message) => message.role === 'user');
        const content = user?.content as { type: string; text?: string }[];
        expect(content.map((block) => block.type)).toEqual([
          'text',
          'image_url',
          'text',
          'image_url',
          'text',
          'image_url',
          'text',
          'image_url',
        ]);
        expect(content[0]?.text).toContain('call_a|item_a');
        expect(content[4]?.text).toContain('call_b');
      } else if (api === 'openai-responses') {
        expect(encoded).toContain('function_call_output');
        expect(encoded).toContain('input_image');
      } else if (api === 'anthropic-messages') {
        expect(encoded).toContain('"is_error":true');
        expect(encoded).toContain('"type":"base64"');
      } else {
        expect(encoded).toContain('inlineData');
        const request = body as { contents: { parts: { functionResponse?: { parts?: unknown[] } }[] }[] };
        const responses = request.contents.flatMap((message) => message.parts).filter((part) => part.functionResponse);
        expect(responses).toHaveLength(2);
        expect(responses[0]?.functionResponse?.parts?.length ?? 0).toBe(modelId.startsWith('gemini-3') ? 2 : 0);
      }
      const scrubbed = scrubModelRequestAuditJson(encoded);
      expect(scrubbed.replacements).toBe(4);
      for (const message of hydrated) {
        if (message.role === 'toolResult') {
          for (const block of message.content) {
            if (block.type === 'image') {
              expect(scrubbed.json).not.toContain(block.data);
            }
          }
        }
      }
      expect(scrubModelRequestAuditJson(scrubbed.json).replacements).toBe(0);
    } finally {
      await stopFixtureServer(http.server);
    }
  });
}
