/**
 * Shared pieces of the Telegram-disabled `serve` acceptance test: the local
 * Responses-API model fixture, a free port, JSON request bodies and the first
 * panel sign-in through the real server CLI.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';

export function sse(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** One Responses-API turn that calls `send` with the given text. */
export function sendTurn(text: string): Response {
  const args = JSON.stringify({ kind: 'text', text });
  return sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: args },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send', arguments: args },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

/** One Responses-API turn with private text only: the round ends without sending. */
export function textTurn(text: string): Response {
  return sse([
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_2',
        status: 'completed',
        output: [],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      },
    },
  ]);
}

/** A port the OS just had free; the configuration requires a real one. */
export async function freePort(): Promise<number> {
  const probe = await startFixtureServer(() => new Response('ok'));
  const address = probe.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await stopFixtureServer(probe.server);
  return port;
}

export function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

/**
 * The panel has no web setup: the first sign-in is a one-time code from the
 * real server CLI, run beside the live `serve` exactly as an operator would.
 * Returns the session cookie.
 */
export async function signInWithCliCode(configPath: string, base: string): Promise<string> {
  const pairing = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, '..', '..', 'src', 'cli.ts'),
    'pairing',
    'create',
    '--web',
    '--config',
    configPath,
  ]);
  const { code } = JSON.parse(pairing.stdout) as { code: string };
  const response = await fetch(`${base}/api/auth/pairing`, jsonBody({ code }));
  if (response.status !== 200) {
    throw new Error(`one-time code sign-in failed with HTTP ${response.status}`);
  }
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
