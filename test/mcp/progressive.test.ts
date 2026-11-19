/**
 * Progressive MCP exposure: servers kept out of the registry behind the one
 * `mcp` gateway tool.
 *
 * Ways this can fail, each pinned below:
 * - a progressive server's tools still reach the registry one by one (no relief
 *   from the 61-tool cap or the request size), or the gateway appears with no
 *   progressive server;
 * - the gateway's index omits a server or its description, so the model cannot
 *   tell what is there;
 * - search, help or call reach a tool outside the Chat's binding, or a direct
 *   tool (discovery must never widen authorization);
 * - call skips the MCP call path: no schema check, no inner `<alias>__<tool>`
 *   audit row (the cutover's unknown-outcome list reads those names), or tool
 *   images lose their positions so the request-time loader drops them;
 * - a Chinese query finds nothing because it carries no spaces;
 * - flipping exposure or editing a description reconnects a server or stops a
 *   Chat's runs, although no permission changed.
 */
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fauxProvider, type ToolResultMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { affectedMcpChatIds } from '../../src/capabilities/mcp/bindings.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { loadToolImages } from '../../src/capabilities/media/tool-images.ts';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import type { McpServerConfig, RawConfig } from '../../src/platform/config/index.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { toolImageReferences } from '../../src/platform/tool-images.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { fixture } from '../admin/fixtures.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { afterThisTest } from '../helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
const BULK = join(import.meta.dirname, '..', 'fixtures', 'mcp-bulk-server.ts');
const DESCRIPTION = '回显文本、等待延迟并返回测试图片的工具服务器。';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});

function directServer(): McpServerConfig {
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

function progressiveServer(): McpServerConfig {
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

function bulkServer(alias: string): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, BULK, '40'],
    tools: '*',
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    default_tool_policy: { read_only: true, timeout_seconds: 10 },
    exposure: 'progressive',
  };
}

async function progressiveFixture() {
  const f = await fixture();
  const seed = seedAdminFixture(f.store);
  const config: RawConfig = {
    ...f.loaded.config,
    mcp: { servers: [directServer(), progressiveServer(), bulkServer('bulk-a'), bulkServer('bulk-b')] },
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

function gatewayOf(tools: readonly AgentTool[]): AgentTool {
  const gateway = tools.find((tool) => tool.name === 'mcp');
  if (gateway === undefined) {
    throw new Error('the mcp gateway is missing');
  }
  return gateway;
}

function text(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

async function search(gateway: AgentTool, id: string, input: Record<string, unknown>) {
  return JSON.parse(text(await gateway.execute(id, { action: 'search', ...input }))) as {
    readonly tools: readonly { readonly tool: string; readonly summary: string; readonly read_only: boolean }[];
    readonly omitted?: number;
    readonly hint?: string;
  };
}

function auditRows(f: Awaited<ReturnType<typeof progressiveFixture>>) {
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

test('progressive servers leave the registry: one mcp gateway indexes them and the cap counts it once', async () => {
  const f = await progressiveFixture();
  const tools = f.tools();
  expect(tools.map((tool) => tool.name)).toEqual(['direct-a__echo', 'mcp']);
  // The registry check measured the set the model gets, not 84 tools.
  expect(f.registries).toContainEqual(['direct-a__echo', 'mcp']);
  const description = gatewayOf(tools).description;
  expect(description).toContain(`- prog-b (3 tools): ${DESCRIPTION}`);
  expect(description).toContain(
    '- bulk-a (40 tools): no description; tools include tool1, tool2, tool3, tool4, tool5, tool6, tool7, tool8, …',
  );
  expect(description).toContain('- bulk-b (40 tools)');

  // The same servers listed directly would be 84 registry tools.
  const direct: RawConfig = {
    ...f.config,
    mcp: {
      servers: (f.config.mcp?.servers ?? []).map(({ exposure: _exposure, ...server }) => server as McpServerConfig),
    },
  };
  expect(f.manager.toolSets(direct).map((set) => set.tools.length)).toContain(84);
  // A configuration without any progressive server gets no gateway at all.
  const directOnly: RawConfig = { ...f.config, mcp: { servers: [directServer()] } };
  expect(f.tools(directOnly).map((tool) => tool.name)).toEqual(['direct-a__echo']);
}, 60_000);

test('mcp search, help and call stay inside the resolved set and audit both rows', async () => {
  const f = await progressiveFixture();
  const gateway = gatewayOf(f.tools());

  expect((await search(gateway, 's1', { query: 'echo text' })).tools[0]?.tool).toBe('prog-b__echo');
  expect((await search(gateway, 's2', { server: 'prog-b' })).tools).toEqual([
    { tool: 'prog-b__echo', summary: 'Echo text with a server-side call count', read_only: true },
    { tool: 'prog-b__wait', summary: 'Answer only after the given delay', read_only: false },
    { tool: 'prog-b__images', summary: 'Return two native MCP images with ordered text', read_only: true },
  ]);
  // A server alone lists every tool it has.
  const bulk = await search(gateway, 's3', { server: 'bulk-a' });
  expect(bulk.tools).toHaveLength(40);
  // A Chinese query has no spaces; its words still match the server's description.
  const chinese = await search(gateway, 's4', { query: '帮我等待一下' });
  expect(chinese.tools.map((tool) => tool.tool)).toEqual(['prog-b__echo', 'prog-b__wait', 'prog-b__images']);
  const nothing = await search(gateway, 's5', { query: '天气预报' });
  expect(nothing.tools).toEqual([]);
  expect(nothing.hint).toContain('server');
  await expect(gateway.execute('s6', { action: 'search', server: 'nope' })).rejects.toThrow(/no server named nope/);

  const help = JSON.parse(text(await gateway.execute('h1', { action: 'help', tool: 'prog-b__echo' }))) as {
    readonly input_schema: { readonly properties: Record<string, unknown> };
    readonly read_only: boolean;
  };
  expect(Object.keys(help.input_schema.properties)).toEqual(['text']);
  expect(help.read_only).toBe(true);

  const called = await gateway.execute('c1', { action: 'call', tool: 'prog-b__echo', input: { text: 'hi' } });
  expect(text(called)).toContain(':hi');
  // The schema is checked before any request; the model is pointed at help.
  await expect(gateway.execute('c2', { action: 'call', tool: 'prog-b__echo', input: {} })).rejects.toThrow(
    /read it with action help/,
  );
  // A direct tool is not reachable through the gateway, and names are never guessed into existence.
  await expect(gateway.execute('c3', { action: 'call', tool: 'direct-a__echo', input: { text: 'x' } })).rejects.toThrow(
    /no tool named direct-a__echo/,
  );
  await expect(gateway.execute('c4', { action: 'call', tool: 'prog-b__echo' })).rejects.toThrow(
    /requires an input object/,
  );

  const rows = auditRows(f);
  const byId = new Map(rows.map((row) => [row.toolCallId, row]));
  expect(byId.get('s1')).toMatchObject({ toolName: 'mcp', state: 'success', sideEffect: false });
  expect(byId.get('s6')).toMatchObject({ toolName: 'mcp', state: 'error', errorCode: 'unknown_server' });
  expect(byId.get('c1')).toMatchObject({ toolName: 'mcp', state: 'success', sideEffect: false });
  expect(byId.get('c1:prog-b__echo')).toMatchObject({ toolName: 'prog-b__echo', state: 'success' });
  expect(byId.get('c2')).toMatchObject({ toolName: 'mcp', state: 'error', errorCode: 'invalid_arguments' });
  expect(byId.has('c2:prog-b__echo')).toBe(false);
  expect(byId.get('c3')).toMatchObject({ toolName: 'mcp', state: 'error', errorCode: 'unknown_tool' });
  expect(byId.get('c4')).toMatchObject({ toolName: 'mcp', state: 'error', errorCode: 'invalid_arguments' });
  // Only the real tool name feeds the cutover's unknown-outcome list.
  expect(rows.filter((row) => row.toolName.includes('__')).map((row) => row.toolCallId)).toEqual(['c1:prog-b__echo']);
}, 60_000);

test('a Chat binding narrows what the gateway can find and call', async () => {
  const f = await progressiveFixture();
  const chats = f.config.telegram.chats.map((chat, index) =>
    index === 0 ? { ...chat, mcp: [{ server: 'prog-b', tools: ['echo'] }] } : chat,
  );
  const bound: RawConfig = { ...f.config, telegram: { ...f.config.telegram, chats } };
  const tools = f.tools(bound);
  expect(tools.map((tool) => tool.name)).toEqual(['mcp']);
  const gateway = gatewayOf(tools);
  expect(gateway.description).toContain('- prog-b (1 tool):');
  expect(gateway.description).not.toContain('bulk-a');
  expect((await search(gateway, 'b1', { server: 'prog-b' })).tools.map((tool) => tool.tool)).toEqual(['prog-b__echo']);
  expect((await search(gateway, 'b2', { query: 'delay' })).tools).toEqual([]);
  await expect(gateway.execute('b3', { action: 'call', tool: 'prog-b__wait', input: { ms: 0 } })).rejects.toThrow(
    /no tool named prog-b__wait/,
  );
  await expect(gateway.execute('b4', { action: 'search', server: 'bulk-a' })).rejects.toThrow(/no server named bulk-a/);
}, 60_000);

test('tool images from a gateway call keep their positions and load under the gateway call id', async () => {
  const f = await progressiveFixture();
  const gateway = gatewayOf(f.tools());
  const result = await gateway.execute('img-1', { action: 'call', tool: 'prog-b__images', input: {} });
  const references = toolImageReferences(result.details);
  expect(references).toHaveLength(2);
  const rows = new Map(auditRows(f).map((row) => [row.toolCallId, row]));
  // Both rows keep the snapshot: the panel shows the images and retention keeps the assets.
  expect(rows.get('img-1')?.resultContentJson).not.toBeNull();
  expect(rows.get('img-1:prog-b__images')?.resultContentJson).not.toBeNull();

  const message: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: 'img-1',
    toolName: 'mcp',
    content: result.content,
    details: result.details,
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  const encoded = encodeContextMessage(message);
  if (encoded === undefined) {
    throw new Error('the tool result did not encode');
  }
  f.contexts.append(f.context.header, {
    invocationId: f.seed.invocationA,
    role: encoded.role,
    json: encoded.json,
    estTokens: 100,
    isCheckpoint: false,
  });
  const [loaded] = await loadToolImages([message], {
    orm: f.store.orm,
    dataDir: f.loaded.config.data_dir,
    conversationId: f.seed.conversationId,
    chatId: f.seed.chatId,
    model: fauxProvider({ models: [{ id: 'image-test', input: ['text', 'image'] }] }).getModel(),
    signal: new AbortController().signal,
  });
  if (loaded?.role !== 'toolResult') {
    throw new Error('the tool result did not load');
  }
  expect(loaded.content.filter((block) => block.type === 'image')).toHaveLength(2);
}, 60_000);

test('exposure and description edits neither reconnect a server nor stop any Chat', async () => {
  const f = await progressiveFixture();
  const flipped: RawConfig = {
    ...f.config,
    mcp: {
      servers: (f.config.mcp?.servers ?? []).map((server) =>
        server.alias === 'prog-b'
          ? { ...server, exposure: 'direct' as const, description: 'Edited description' }
          : server.alias === 'direct-a'
            ? { ...server, exposure: 'progressive' as const }
            : server,
      ),
    },
  };
  expect(affectedMcpChatIds(f.config, flipped)).toEqual([]);
  const result = await f.manager.reconcile({ config: flipped, generation: 1 });
  expect(result).toMatchObject({ added: [], replaced: [], removed: [], failed: [] });
  const tools = f.tools(flipped);
  expect(tools.map((tool) => tool.name)).toEqual(['prog-b__echo', 'prog-b__wait', 'prog-b__images', 'mcp']);
  expect(gatewayOf(tools).description).toContain('- direct-a (1 tool): no description; tools include echo');
  // The flipped server's tools still run on the instance that never reconnected.
  const echo = tools.find((tool) => tool.name === 'prog-b__echo');
  expect(text(await (echo as AgentTool).execute('d1', { text: 'still' }))).toContain(':still');
}, 60_000);

test('execute refuses the mcp gateway like any other runtime primitive', async () => {
  const f = await progressiveFixture();
  const execute = createExecuteTool({ audit: createToolAudit(f.store, f.seed.invocationA), capabilities: [] });
  await expect(execute.execute('x1', { action: 'help', tool: 'mcp' })).rejects.toThrow(/call it directly/);
  expect(() =>
    createExecuteTool({
      audit: createToolAudit(f.store, f.seed.invocationA),
      capabilities: [{ tool: gatewayOf(f.tools()), sideEffect: false }],
    }),
  ).toThrow(/cannot be registered/);
}, 60_000);
