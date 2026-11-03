import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import sharp from 'sharp';

const expectedPath = process.argv[2];
if (!expectedPath) {
  throw new Error('A private expected-answer path is required');
}
const code = randomBytes(3).toString('hex').toUpperCase();
await writeFile(expectedPath, code, { mode: 0o600, flag: 'wx' });
const bytes = await sharp(
  Buffer.from(
    `<svg width="640" height="240"><rect width="640" height="240" fill="white"/><text x="50" y="155" fill="black" font-family="monospace" font-size="90">${code}</text></svg>`,
  ),
)
  .png()
  .toBuffer();
const server = new McpServer({ name: 'isolated-vision-verification', version: '1.0.0' });
server.registerTool(
  'capture',
  {
    description: 'Return an image containing a random six-character code',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] }),
);
await server.connect(new StdioServerTransport());
