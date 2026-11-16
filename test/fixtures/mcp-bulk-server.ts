import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// First argument: how many tools to expose. Used to prove that the tool-registry
// cap is checked against the set one Chat resolves to, not the union of every
// server in the file.
const count = Number(process.argv[2] ?? '40');
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error('mcp-bulk-server expects a positive tool count');
}

const server = new McpServer({ name: 'surowan-bulk-test', version: '1.0.0' });
for (let index = 1; index <= count; index += 1) {
  server.registerTool(
    `tool${index}`,
    {
      description: `Bulk tool ${index}`,
      inputSchema: z.object({ value: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: `tool${index}` }] }),
  );
}

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }));
