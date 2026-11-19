import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// First argument: how many tools to expose. Used to prove that the tool-registry
// cap is checked against the set one Chat resolves to, not the union of every
// server in the file. Optional second argument: a prefix for every tool name
// (an exposed-name collision needs a `__` inside one). Optional third: how many
// CJK characters to append to each description (a search page's byte budget).
const count = Number(process.argv[2] ?? '40');
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error('mcp-bulk-server expects a positive tool count');
}
const prefix = process.argv[3] ?? '';
const padding = '工'.repeat(Number(process.argv[4] ?? '0'));

const server = new McpServer({ name: 'surowan-bulk-test', version: '1.0.0' });
for (let index = 1; index <= count; index += 1) {
  server.registerTool(
    `${prefix}tool${index}`,
    {
      description: `Bulk tool ${index}${padding}`,
      inputSchema: z.object({ value: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: `${prefix}tool${index}` }] }),
  );
}

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }));
