// Shared fixtures for the split `surowan-utils login and doctor` suites.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';
import { runCli } from '../packages/cli/src/run.ts';

export const KEY = 'synthetic-login-key-never-print';
const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

export async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plasticwan-login-'));
  cleanup.push(async () => await rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function server(
  handler: (response: ServerResponse, request: { method: string | undefined; url: string | undefined }) => void,
) {
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> =
    [];
  const http = createServer((request, response) => {
    const captured = { method: request.method, url: request.url, authorization: request.headers.authorization };
    requests.push(captured);
    handler(response, captured);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture failed to bind');
  }
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function cli(args: readonly string[], homeDir: string, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    homeDir,
    env,
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  });
  return { code, stdout, stderr };
}

export async function child(
  args: readonly string[],
  homeDir: string,
  input: string,
  keepOpen = false,
  overrides: Record<string, string> = {},
) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.SUROWAN_API_KEY;
  delete env.SUROWAN_ENDPOINT;
  Object.assign(env, overrides);
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [BIN, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    let stdout = '';
    let stderr = '';
    process.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    process.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    process.on('error', reject);
    process.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    process.stdin.on('error', () => {});
    process.stdin.write(input);
    if (!keepOpen) {
      process.stdin.end();
    }
  });
}

export function terminal() {
  let stderr = '';
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (value: boolean) => {
      rawModes.push(value);
    },
  });
  const output = Object.assign(
    new Writable({
      write: (chunk, _encoding, callback) => {
        stderr += String(chunk);
        callback();
      },
    }),
    { isTTY: true },
  );
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stderr', 'get').mockReturnValue(output as unknown as typeof process.stderr);
  cleanup.push(async () => {
    input.destroy();
    output.destroy();
  });
  return { input, rawModes, stderr: () => stderr };
}
