/**
 * Shared fixture for the panel-surface suites.
 *
 * Each case boots a real `AdminServer` over a real SQLite store and a real
 * `config.jsonc`, then serves it over a loopback HTTP socket so the real CLI
 * binary (a separate process) talks to the same code the browser panel uses.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import { AdminServer } from '../../../src/ingress/admin/index.ts';
import { ConfigReloader } from '../../../src/adapters/local-monolith/config/reload.ts';
import { type LoadedConfig, loadConfig } from '../../../src/adapters/local-monolith/config/index.ts';
import type { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { AgentModelSwitcher } from '../../../src/platform/models/switch.ts';
import { keyJarPath } from '../../../src/platform/key-jar.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import { PlaygroundAssetStore } from '../../../src/capabilities/media/local-assets.ts';
import { PlaygroundIngress } from '../../../src/ingress/playground.ts';
import { PlaygroundStore } from '../../../src/store/playground/index.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../../helpers.ts';

const BIN = fileURLToPath(new URL('../../../packages/cli/src/bin.ts', import.meta.url));
export const PASSWORD = 'correct-horse-battery';
export const USERNAME = 'owner';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export interface PanelFixture {
  readonly baseUrl: string;
  readonly home: string;
  readonly configPath: string;
  readonly store: SqliteStore;
  close(): Promise<void>;
}

/**
 * Serves the real `AdminServer.handle` over a loopback HTTP socket, because the
 * CLI is a separate process and must speak HTTP to the same code the panel uses.
 */
export async function panelFixture(): Promise<PanelFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-cli-panel-'));
  directories.push(directory);
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true });
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const configStore: RuntimeConfigurationStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keyJarPath(configPath));
  const switcher = new AgentModelSwitcher(configStore);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    secrets,
    validateAgentModel: () => undefined,
    modelSwitcher: switcher,
    onPublished: () => undefined,
  });
  const assets = new PlaygroundAssetStore({ orm: store.orm, root: join(directory, 'images', 'playground') });
  const rooms = new PlaygroundStore(store.orm);
  const ingress = new PlaygroundIngress(store.orm, { assets });
  const server = new AdminServer({
    store,
    configStore,
    configReloader: reloader,
    modelSwitcher: switcher,
    secrets,
    playground: { store, rooms, ingress, assets },
  });

  const sockets = new Set<Socket>();
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value.join(', '));
        }
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks);
      void server
        .handle(
          new Request(url, {
            method: request.method ?? 'GET',
            headers,
            ...(body.byteLength === 0 ? {} : { body }),
          }),
        )
        .then(async (result) => {
          const payload = Buffer.from(await result.arrayBuffer());
          const responseHeaders: Record<string, string> = {};
          result.headers.forEach((value, key) => {
            // A repeated `set-cookie` must stay separate for the CLI to parse it.
            responseHeaders[key] = value;
          });
          const cookies = result.headers.getSetCookie();
          response.writeHead(result.status, {
            ...responseHeaders,
            ...(cookies.length === 0 ? {} : { 'set-cookie': cookies }),
          });
          response.end(payload);
        })
        .catch(() => {
          response.writeHead(500).end();
        });
    });
  });
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const listening = Promise.withResolvers<void>();
  http.once('error', listening.reject);
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the panel fixture did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    home,
    configPath,
    store,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      const closed = Promise.withResolvers<void>();
      http.close(() => closed.resolve());
      await closed.promise;
      store.close();
    },
  };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  /** Written to the child's stdin and then closed. */
  readonly stdin?: string;
}

export function runCli(
  args: readonly string[],
  fixture: PanelFixture,
  env: Record<string, string> = {},
  options: RunCliOptions = {},
): Promise<CliResult> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.SUROWAN_ENDPOINT;
  delete childEnv.SUROWAN_API_KEY;
  delete childEnv.SUROWAN_SESSION;
  childEnv.HOME = fixture.home;
  childEnv.USERPROFILE = fixture.home;
  Object.assign(childEnv, env);
  const result = Promise.withResolvers<CliResult>();
  const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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
  child.on('error', result.reject);
  child.on('close', (code) => result.resolve({ code: code ?? -1, stdout, stderr }));
  if (options.stdin === undefined) {
    child.stdin.end();
  } else {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  return result.promise;
}

export function storedSession(fixture: PanelFixture): string {
  const path = join(fixture.home, '.config', 'surowan-utils', 'credentials.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { session: string };
  return parsed.session;
}

export async function loginPanel(fixture: PanelFixture): Promise<void> {
  const login = await runCli(
    ['login', '--endpoint', fixture.baseUrl, '--username', USERNAME, '--password', PASSWORD, '--json'],
    fixture,
  );
  expect(login.code, login.stderr).toBe(0);
}

export function errorCode(result: CliResult): string {
  const parsed: unknown = JSON.parse(result.stderr);
  return typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String(parsed.error) : '';
}
