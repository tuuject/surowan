/**
 * Shared harness for the progressive MCP exposure suites: real stdio fixture
 * servers behind a real `McpManager`, a seeded invocation for the audit rows,
 * and helpers that drive the `mcp` gateway the way the model does.
 */
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { eq } from 'drizzle-orm';
import { afterEach } from 'vitest';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import type { McpServerConfig, RawConfig } from '../../src/platform/config/index.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
import { fixture } from '../admin/fixtures.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { afterThisTest } from '../helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
const BULK = join(import.meta.dirname, '..', 'fixtures', 'mcp-bulk-server.ts');
export const DESCRIPTION = '回显文本、等待延迟并返回测试图片的工具服务器。';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});

export function directServer(): McpServerConfig {
  return {
    alias: 'direct-a',
    transport: 'stdio',
    command: [process.execPath, FIXTURE],
    tools: ['echo'],
    payload_max_bytes: 1_048_576,
    result_max_bytes: 32_768,
    tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 10 }],
  };
}

export function progressiveServer(): McpServerConfig {
  return {
    alias: 'prog-b',
    transport: 'stdio',
    command: [process.execPath, FIXTURE],
    tools: ['echo', 'wait', 'images'],
    payload_max_bytes: 1_048_576,
    result_max_bytes: 32_768,
    tool_policies: [
      { name: 'echo', read_only: true, timeout_seconds: 10 },
      { name: 'wait', read_only: false, timeout_seconds: 10 },
      { name: 'images', read_only: true, timeout_seconds: 10 },
    ],
    exposure: 'progressive',
    description: DESCRIPTION,
  };
}

export function bulkServer(alias: string, args: readonly string[] = ['40']): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, BULK, ...args],
    tools: '*',
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    default_tool_policy: { read_only: true, timeout_seconds: 10 },
    exposure: 'progressive',
  };
}

export async function progressiveFixture(
  servers: readonly McpServerConfig[] = [
    directServer(),
    progressiveServer(),
    bulkServer('bulk-a'),
    bulkServer('bulk-b'),
  ],
) {
  const f = await fixture();
  const seed = seedAdminFixture(f.store);
  const config: RawConfig = {
    ...f.loaded.config,
    mcp: { servers: [...servers] },
  };
  const manager = new McpManager(f.store, config, new SecretStore());
  const close = async (): Promise<void> => {
    if (f.store.db.open) {
      await manager.stop();
      await f.server.stop();
      f.store.close();
    }
  };
  afterThisTest(close, () => {
    closes.push(close);
  });
  const registries: string[][] = [];
  manager.setRegistryValidator((tools) => {
    registries.push(tools.map((tool) => tool.name));
  });
  await manager.start();
  await awaitServerAttempts(manager);
  const contexts = new ConversationContextStore(f.store);
  const { header } = contexts.open(seed.conversationId, 'mcp-progressive-test');
  const context = {
    ...previewContext('telegram'),
    invocationId: seed.invocationA,
    conversationId: seed.conversationId,
    hostChatId: BigInt(f.loaded.config.telegram.chats[0]?.id ?? 0),
    internalChatId: seed.chatId,
    header,
  };
  const tools = (configuration: RawConfig = config): readonly AgentTool[] =>
    manager.createTools(context, Date.now() + 30_000, configuration);
  return { ...f, seed, config, manager, context, contexts, registries, tools };
}

export function gatewayOf(tools: readonly AgentTool[]): AgentTool {
  const gateway = tools.find((tool) => tool.name === 'mcp');
  if (gateway === undefined) {
    throw new Error('the mcp gateway is missing');
  }
  return gateway;
}

export function text(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

export async function search(gateway: AgentTool, id: string, input: Record<string, unknown>) {
  return JSON.parse(text(await gateway.execute(id, { action: 'search', ...input }))) as {
    readonly tools: readonly { readonly tool: string; readonly summary: string; readonly read_only: boolean }[];
    readonly total: number;
    readonly next_offset?: number;
    readonly hint?: string;
  };
}

export function auditRows(f: Awaited<ReturnType<typeof progressiveFixture>>) {
  return f.store.orm
    .select({
      toolCallId: toolCalls.toolCallId,
      toolName: toolCalls.toolName,
      state: toolCalls.state,
      errorCode: toolCalls.errorCode,
      sideEffect: toolCalls.sideEffect,
      resultContentJson: toolCalls.resultContentJson,
    })
    .from(toolCalls)
    .where(eq(toolCalls.invocationId, f.seed.invocationA))
    .all();
}
