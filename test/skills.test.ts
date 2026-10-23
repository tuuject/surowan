import { afterAll, expect, test } from 'vitest';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import sharp from 'sharp';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { capability } from '../src/capabilities/execute-tool.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { createMemoryTools, MemoryStore } from '../src/context/memory.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { StickerService } from '../src/capabilities/stickers.ts';
import { bundledSystemResources, fauxRegistry, testTelegramRuntime } from './helpers.ts';
import {
  cleanupSkillDirectories,
  type InvocationSetup,
  lastToolResult,
  setupInvocation,
  skillAgentRuntime,
  toolResultText,
  trackSkillTempPath,
} from './skills-fixtures.ts';

afterAll(cleanupSkillDirectories);

async function indexOneSticker(
  setup: InvocationSetup,
  visionFaux: ReturnType<typeof fauxProvider>,
): Promise<{ stickers: StickerService; stickerId: bigint }> {
  const { store, loaded, configStore } = setup;
  const fixturePath = join(tmpdir(), `plasticwan-skills-sticker-${crypto.randomUUID()}.webp`);
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .webp()
    .toFile(fixturePath);
  trackSkillTempPath(fixturePath);
  visionFaux.setResponses([
    () =>
      fauxAssistantMessage(
        fauxToolCall('report_sticker_analysis', {
          description_zh: '一只委屈猫正在哭泣',
          emotion_zh: ['委屈'],
          action_zh: ['哭泣'],
          tags_zh: ['猫'],
          tags_en: ['cat'],
        }),
      ),
  ]);
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      await copyFile(fixturePath, destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const stickers = new StickerService({
    store,
    config: loaded.config,
    media,
    api: {
      getStickerSet: async () => ({
        name: 'CatSet',
        title: 'Cats',
        stickers: [
          {
            file_id: 'sticker-file',
            file_unique_id: 'sticker-unique',
            width: 64,
            height: 64,
            is_animated: false,
            is_video: false,
            emoji: '😭',
            thumbnail: { file_id: 'thumb-file' },
          },
        ],
      }),
    },
  });
  await stickers.sync();
  expect(await stickers.runOne()).toBe(true);
  const stickerId = store.db.prepare<[], { id: bigint }>('SELECT id FROM stickers').get()?.id;
  if (stickerId === undefined) {
    throw new Error('Sticker indexing did not create a row');
  }
  return { stickers, stickerId };
}

test('the skill index reaches the system prompt and primitives stay directly callable', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('plasticwan-skills-index-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain('System skills:');
      expect(getCurrentSystemPrompt(context.messages)).toContain('system:///skills/sticker-search/SKILL.md');
      expect(getCurrentSystemPrompt(context.messages)).toContain('This index is the complete list');
      expect(getCurrentSystemPrompt(context.messages)).toContain('read_image capability (called via execute)');
      expect(getCurrentSystemPrompt(context.messages)).toContain('add_memory capability (called via execute)');
      expect(getCurrentSystemPrompt(context.messages)).not.toContain('# Web fetch');
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
        'read',
        'send',
        'send_reply',
        'execute',
      ]);
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'web_fetch' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const help = lastToolResult(context.messages);
      expect(help.isError).toBe(false);
      const parsed = JSON.parse(toolResultText(help)) as { name: string; parameters: unknown };
      expect(parsed.name).toBe('web_fetch');
      expect(parsed.parameters).toMatchObject({ type: 'object' });
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'search', query: 'fetch a web page' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const search = lastToolResult(context.messages);
      const results = JSON.parse(toolResultText(search)) as { name: string; summary: string }[];
      expect(results.some((result) => result.name === 'web_fetch' && result.summary === 'Fetch a web page')).toBe(true);
      return fauxAssistantMessage('done');
    },
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = await skillAgentRuntime(store, setup.configStore, (context, deadline) => [
    ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
    ...loadPlugins(BUILTIN_PLUGINS).capabilities(store, setup.loaded.config, context, deadline),
  ]);
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const executeRows = store.db
    .prepare<[], { state: string; error_code: string | null }>(
      "SELECT state, error_code FROM tool_calls WHERE tool_name = 'execute' ORDER BY id",
    )
    .all();
  expect(executeRows).toEqual([
    { state: 'success', error_code: null },
    { state: 'success', error_code: null },
  ]);
  store.close();
});

test('search_stickers runs through execute and its refs authorize a sticker send', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const setup = await setupInvocation('plasticwan-skills-sticker-', true, {
    models,
    visionModel: visionFaux.getModel(),
  });
  const { store } = setup;
  const { stickers, stickerId } = await indexOneSticker(setup, visionFaux);
  agentFaux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain('search_stickers capability via execute');
      expect(context.messages.some((message) => message.role === 'user')).toBe(true);
      return fauxAssistantMessage(
        fauxToolCall('execute', {
          action: 'call',
          tool: 'search_stickers',
          input: { ids: [stickerId.toString()] },
        }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const call = lastToolResult(context.messages);
      expect(call.isError).toBe(false);
      const envelope = JSON.parse(toolResultText(call)) as {
        text: string;
        refs: { sticker_ref: string[] };
      };
      expect(envelope.text).toContain(stickerId.toString());
      expect(envelope.refs.sticker_ref).toHaveLength(1);
      const stickerRef = envelope.refs.sticker_ref[0];
      if (stickerRef === undefined || !stickerRef.startsWith('stk_')) {
        throw new Error('Expected an authorized stk_ sticker_ref');
      }
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'sticker', sticker_ref: stickerRef }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('sent'),
  ]);
  let sentSticker: string | undefined;
  const runtime = new AgentRuntime({
    store,
    configStore: setup.configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
      sendSticker: async (_chatId, sticker) => {
        sentSticker = sticker;
        return { message_id: 502, date: 1, chat: { id: 123456789 } };
      },
    }),
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: await bundledSystemResources(),
    capabilityTools: (context, _deadline, capabilities) => [
      capability(stickers.createSearchTool(context, capabilities), false),
    ],
  });
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  expect(sentSticker).toBe('sticker-file');
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'search_stickers', state: 'success', error_code: null },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  expect(
    store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM host_sends WHERE state = 'success'").get()
      ?.count,
  ).toBe(1n);
  store.close();
});
