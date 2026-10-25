// Shared fixtures for the split `surowan-utils invocation CLI` suites.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../packages/cli/src/bin.ts', import.meta.url));

export const API_KEY = 'test-api-key-a1b2c3';

export const ITEM = {
  id: '7',
  state: 'completed',
  created_at: '2026-10-05T01:02:03.000Z',
  chat: { telegram_chat_id: '-1001234567890', title: 'Test Group', username: null, message_thread_id: 0 },
  total_tokens: 120,
  total_cost: 0.0012,
};

const PREFLIGHT = {
  available: true,
  reason: null,
  message: null,
  prompt_overrides_available: true,
  omitted_images: 0,
  fidelity: {
    input: 'historical_public_chat',
    model_selection: 'current_chat_config',
    prompt_selection: 'current_chat_config',
    tool_selection: 'current_registry',
    hot_injections: 'not_replayed',
    external_tools: 'blocked',
    system_resources: 'current_read_only',
    side_effects: 'synthetic',
  },
};

/** Replay now asks replay-preflight first; route it separately from the POST. */
export function preflightOr(handler: (request: CapturedRequest, response: ServerResponse) => void) {
  return (request: CapturedRequest, response: ServerResponse): void => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path.endsWith('/replay-preflight')) {
      jsonResponse(response, 200, PREFLIGHT);
      return;
    }
    handler(request, response);
  };
}

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface TestServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

export async function startServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(
  args: readonly string[],
  options: {
    readonly env?: Record<string, string>;
    readonly stdin?: string;
    readonly keepStdinOpen?: boolean;
  } = {},
): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SUROWAN_ENDPOINT;
  delete env.SUROWAN_API_KEY;
  // File fallback must never consult the operator's real saved credentials.
  env.HOME = workDir;
  env.USERPROFILE = workDir;
  Object.assign(env, options.env ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.keepStdinOpen === true ? 5_000 : 0,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    if (options.keepStdinOpen !== true) {
      child.stdin.end();
    }
  });
}

export function onlyRequest(server: TestServer): CapturedRequest {
  const request = server.requests.at(0);
  if (request === undefined) {
    throw new Error('the test server received no request');
  }
  return request;
}

export function errorDocument(result: CliResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.stderr);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`stderr was not a JSON object: ${result.stderr}`);
  }
  return parsed as Record<string, unknown>;
}

export function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

let workDir = '';
let promptFile = '';

/** Temp directory each suite exports to HOME/USERPROFILE; must be set before `runCli`. */
export function cliWorkDir(): string {
  return workDir;
}

export function cliPromptFile(): string {
  return promptFile;
}

export async function setupCliWorkDir(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'surowan-cli-'));
  promptFile = join(workDir, 'prompt.txt');
  await writeFile(promptFile, 'from the prompt file');
}

export async function teardownCliWorkDir(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}
