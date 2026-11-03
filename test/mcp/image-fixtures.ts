import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import type { McpToolResult } from '../../src/capabilities/mcp/content.ts';
import { localImageAssets } from '../../src/capabilities/media/local-assets.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { fixture } from '../admin/fixtures.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});

export async function imageFixture(payloadMaxBytes = 1_048_576) {
  const f = await fixture();
  const seed = seedAdminFixture(f.store);
  const manager = new McpManager(
    f.store,
    {
      ...f.loaded.config,
      mcp: {
        servers: [
          {
            alias: 'local',
            transport: 'stdio',
            command: [process.execPath, join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts')],
            required: true,
            tools: ['images', 'echo'],
            payload_max_bytes: payloadMaxBytes,
            result_max_bytes: 32_768,
            default_tool_policy: { read_only: true, timeout_seconds: 10 },
          },
        ],
      },
    },
    new SecretStore(),
  );
  closes.push(async () => {
    if (f.store.db.open) {
      await manager.stop();
      await f.server.stop();
      f.store.close();
    }
  });
  await manager.start();
  const contexts = new ConversationContextStore(f.store);
  const { header } = contexts.open(seed.conversationId, 'mcp-test');
  const context = {
    ...previewContext(),
    invocationId: seed.invocationA,
    conversationId: seed.conversationId,
    internalChatId: seed.chatId,
    header,
  };
  const tool = manager.createTools(context, Date.now() + 30_000).find((tool) => tool.name === 'local__images');
  if (tool === undefined) {
    throw new Error('Missing image tool');
  }
  const assets = localImageAssets(f.store.orm, f.loaded.config.data_dir);
  return { ...f, seed, manager, context, tool, contexts, assets };
}
export type ImageFixture = Awaited<ReturnType<typeof imageFixture>>;

export function appendImageResult(
  f: ImageFixture,
  result: McpToolResult,
  toolCallId = 'call_images',
): ToolResultMessage {
  const message: ToolResultMessage = {
    role: 'toolResult',
    toolCallId,
    toolName: 'local__images',
    content: result.content,
    details: { ...result.details },
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  const encoded = encodeContextMessage(message);
  if (encoded === undefined) {
    throw new Error('Missing encoded result');
  }
  f.contexts.append(f.context.header, {
    invocationId: f.seed.invocationA,
    role: encoded.role,
    json: encoded.json,
    estTokens: 100,
    isCheckpoint: false,
  });
  return message;
}
