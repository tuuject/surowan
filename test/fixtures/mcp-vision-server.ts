import { randomBytes, randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import sharp from 'sharp';

const expectedPath = process.argv[2];
if (!expectedPath) {
  throw new Error('A private expected-answer path is required');
}
const code = randomBytes(3).toString('hex').toUpperCase();
const color = ['RED', 'BLUE', 'GREEN', 'ORANGE', 'PURPLE'][randomInt(5)]!;
const shape = ['CIRCLE', 'SQUARE', 'TRIANGLE'][randomInt(3)]!;
const count = randomInt(2, 7);
await writeFile(expectedPath, JSON.stringify({ code, detail: `${color} ${shape} ${count}` }), {
  mode: 0o600,
  flag: 'wx',
});
const shapes = Array.from({ length: count }, (_, index) => {
  const x = 65 + index * 100;
  if (shape === 'CIRCLE') {
    return `<circle cx="${x}" cy="300" r="32" fill="${color.toLowerCase()}"/>`;
  }
  if (shape === 'SQUARE') {
    return `<rect x="${x - 32}" y="268" width="64" height="64" fill="${color.toLowerCase()}"/>`;
  }
  return `<polygon points="${x},265 ${x - 36},333 ${x + 36},333" fill="${color.toLowerCase()}"/>`;
}).join('');
const bytes = await sharp(
  Buffer.from(
    `<svg width="640" height="400"><rect width="640" height="400" fill="white"/><text x="50" y="155" fill="black" font-family="monospace" font-size="90">${code}</text>${shapes}</svg>`,
  ),
)
  .png()
  .toBuffer();
const server = new McpServer({ name: 'isolated-vision-verification', version: '1.0.0' });
server.registerTool(
  'capture',
  {
    description: 'Return an isolated verification image',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] }),
);
await server.connect(new StdioServerTransport());
