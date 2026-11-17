import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// A fixture whose availability behavior a test choreographs through argv:
//   argv[2]  file that receives this process's PID
//   argv[3]  ms after connect: write one malformed line to stdout — the client
//            sees a transport `onerror` without a close
//   argv[4]  ms after connect: grow the served tool list by 70 filler tools and
//            send one `notifications/tools/list_changed`
//   argv[5]  ms to wait before answering `initialize`; a negative value means
//            never answer (the handshake hangs until the client gives up)
const pidFile = process.argv[2];
if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid));
}
const garbageAt = Number(process.argv[3] ?? '0');
const expandAt = Number(process.argv[4] ?? '0');
const handshakeDelay = Number(process.argv[5] ?? '0');

interface FlapTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, unknown> };
}

const tools: FlapTool[] = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'linger',
    description: 'Answer only after the given delay',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
];

const server = new Server(
  { name: 'surowan-test-flap', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as { text?: string; ms?: number };
  if (request.params.name === 'linger') {
    await delay(args.ms ?? 0);
    return { content: [{ type: 'text', text: 'lingered' }] };
  }
  return { content: [{ type: 'text', text: `flap:${args.text ?? request.params.name}` }] };
});

if (garbageAt > 0) {
  setTimeout(() => {
    process.stdout.write('this frame is not JSON-RPC\n');
  }, garbageAt);
}
if (expandAt > 0) {
  setTimeout(() => {
    for (let index = 0; index < 70; index += 1) {
      tools.push({
        name: `filler_${index}`,
        description: 'A filler tool that only exists to overflow the registry cap',
        inputSchema: { type: 'object', properties: {} },
      });
    }
    void server.notification({ method: 'notifications/tools/list_changed' });
  }, expandAt);
}

if (handshakeDelay < 0) {
  // Never connect a transport: the client's initialize waits forever and the
  // process stays alive, which is the "hung handshake" a stop() must abort.
  setInterval(() => undefined, 60_000);
} else {
  if (handshakeDelay > 0) {
    await delay(handshakeDelay);
  }
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }));
}
