import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { convertMcpResult } from '../../src/capabilities/mcp/content.ts';
import { localImageAssets } from '../../src/capabilities/media/local-assets.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { agentMessages, contextMessages, conversationContexts } from '../../src/store/schema/index.ts';
import { finishToolCall, startToolCall, type BusinessStore } from '../../src/store/store.ts';
import type { AdminSeedResult } from './admin-seed.ts';

/** Optional UI fixture; goes through the same native-image converter as MCP. */
export async function seedAdminToolImages(store: BusinessStore, dataDir: string, seed: AdminSeedResult): Promise<void> {
  const images = await Promise.all(
    ['#3156a0', '#16754e'].map(async (background, index) => ({
      type: 'image' as const,
      mimeType: 'image/png',
      data: (
        await sharp(
          Buffer.from(
            `<svg width="480" height="200"><rect width="480" height="200" fill="${background}"/><text x="32" y="115" fill="white" font-size="36">MCP image ${index + 1}</text></svg>`,
          ),
        )
          .png()
          .toBuffer()
      ).toString('base64'),
    })),
  );
  const result = await convertMcpResult(
    {
      content: [
        { type: 'text', text: 'Before MCP images' },
        images[0]!,
        { type: 'text', text: 'Between MCP images' },
        images[1]!,
        { type: 'text', text: 'After MCP images' },
      ],
    },
    { serverAlias: 'fixture', originalName: 'capture', resultMaxBytes: 32_768 },
    { ...previewContext(), internalChatId: seed.chatId, conversationId: seed.conversationId },
    localImageAssets(store.orm, dataDir),
    new AbortController().signal,
  );
  const callId = 'call_mcp_images';
  const id = startToolCall(store.orm, seed.invocationA, callId, 'fixture__capture', '{}', false);
  finishToolCall(store.orm, id, 'success', 'MCP images', null, { resultContentJson: JSON.stringify(result) });
  const message = {
    role: 'toolResult',
    toolName: 'fixture__capture',
    toolCallId: callId,
    ...result,
    isError: false,
    timestamp: Date.now(),
  };
  store.orm
    .insert(contextMessages)
    .values({
      contextId: seed.contextId,
      seq: 5n,
      role: 'toolResult',
      payloadJson: JSON.stringify(message),
      invocationId: seed.invocationA,
      isCheckpoint: false,
      estTokens: 200n,
      createdAt: new Date().toISOString(),
    })
    .run();
  store.orm.update(conversationContexts).set({ nextSeq: 6n }).where(eq(conversationContexts.id, seed.contextId)).run();
  store.orm
    .insert(agentMessages)
    .values({
      invocationId: seed.invocationA,
      sequenceNo: 999n,
      role: 'tool_result',
      text: 'MCP images',
      toolCallId: callId,
      createdAt: new Date().toISOString(),
    })
    .run();
}
