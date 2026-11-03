import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import sharp from 'sharp';

// Optional first argument: a file that receives this process's PID, so a test
// can check whether the manager closed the server.
const pidFile = process.argv[2];
if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid));
}

const server = new McpServer({ name: 'surowan-test', version: '1.0.0' });
let calls = 0;
server.registerTool(
  'echo',
  {
    description: 'Echo text with a server-side call count',
    inputSchema: z.object({ text: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  },
  ({ text }) => {
    calls += 1;
    return { content: [{ type: 'text', text: `${calls}:${text}` }] };
  },
);

server.registerTool(
  'images',
  {
    description: 'Return two native MCP images with ordered text',
    inputSchema: z.object({
      error: z.boolean().optional(),
      only: z.boolean().optional(),
      invalid: z.boolean().optional(),
      oversized: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ error, only, invalid, oversized }) => {
    const images = await Promise.all(
      ['red', 'blue'].map(async (background) => ({
        type: 'image' as const,
        mimeType: 'image/png',
        data: oversized
          ? Buffer.alloc(8192, 42).toString('base64')
          : invalid
            ? 'aW52YWxpZA=='
            : (
                await sharp({ create: { width: 32, height: 24, channels: 4, background } })
                  .png()
                  .toBuffer()
              ).toString('base64'),
      })),
    );
    return {
      isError: error === true,
      content: only
        ? images
        : [
            { type: 'text' as const, text: 'before' },
            images[0]!,
            { type: 'text' as const, text: 'between' },
            images[1]!,
            { type: 'text' as const, text: 'after' },
          ],
    };
  },
);

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }));
