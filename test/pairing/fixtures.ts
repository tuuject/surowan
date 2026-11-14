import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import { canonicalSignatureString, formatSignatureAuthorization, pairingProofString } from '@surowan/admin-surface';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { runCli } from '../../packages/cli/src/run.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

export const SERVER_CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const CLIENT_CLI = fileURLToPath(new URL('../../packages/cli/src/bin.ts', import.meta.url));

const directories: string[] = [];

/** Every CLI byte this file produced, so a leak test can scan the whole run. */
export const cliOutput: string[] = [];

/** Registers the directory teardown every pairing file needs. */
export function installPairingHooks(): void {
  afterAll(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
    );
  });
}

/**
 * A throwaway directory removed by `installPairingHooks`, including hosts that
 * are not full fixtures (a bare HOME for CLI argument and key-file tests).
 */
export async function makeScratchDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TestIdentity {
  readonly privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key, base64url. */
  readonly publicKey: string;
}

export interface PairingFixture {
  readonly directory: string;
  readonly configPath: string;
  readonly home: string;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly baseUrl: string;
  /** Rebuilds the AdminServer over the same store, as a process restart would. */
  restart(): Promise<string>;
  close(): Promise<void>;
}

export function newIdentity(): TestIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new Error('generated key has no raw public half');
  }
  return { privateKey, publicKey: jwk.x };
}

export interface PairingFixtureOptions {
  /** The panel's public URL; absent leaves the deployment on a loopback URL. */
  readonly publicUrl?: string;
  /** The bind address the config file records; defaults to loopback. */
  readonly bindHost?: string;
}

export async function pairingFixture(options: PairingFixtureOptions = {}): Promise<PairingFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-pairing-'));
  const home = await mkdtemp(join(tmpdir(), 'surowan-pairing-home-'));
  directories.push(directory, home);
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
        host: options.bindHost ?? '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
        ...(options.publicUrl === undefined ? {} : { public_url: options.publicUrl }),
      };
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const admin = loaded.config.admin;
  if (admin === undefined) {
    throw new Error('fixture config has no admin block');
  }
  // The schema pins admin.port >= 1; port 0 lets the OS assign a loopback port.
  admin.port = 0;
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  let server = new AdminServer({ store, configStore, secrets: new SecretStore() });
  let baseUrl = await start(server);
  const fixture: PairingFixture = {
    directory,
    configPath,
    home,
    store,
    configStore,
    get baseUrl() {
      return baseUrl;
    },
    restart: async () => {
      await server.stop();
      server = new AdminServer({ store, configStore, secrets: new SecretStore() });
      baseUrl = await start(server);
      return baseUrl;
    },
    close: async () => {
      await server.stop();
      store.close();
    },
  };
  return fixture;
}

async function start(server: AdminServer): Promise<string> {
  const listening = await server.start();
  return `http://127.0.0.1:${listening.port}`;
}

/** The real server CLI, spawned against the live data directory: prove it coexists with `serve`. */
export async function runServerCli(configPath: string, args: readonly string[]): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SUROWAN_ENDPOINT;
  delete env.SUROWAN_API_KEY;
  const result = await spawnCli(SERVER_CLI, [...args, '--config', configPath], env);
  cliOutput.push(result.stdout, result.stderr);
  return result;
}

/** In-process client CLI on a temp HOME: no real env and no saved credentials. */
export async function runClientCli(home: string, args: readonly string[]): Promise<CliResult> {
  const output = { stdout: '', stderr: '' };
  const code = await runCli(args, {
    homeDir: home,
    env: {},
    io: {
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    },
  });
  cliOutput.push(output.stdout, output.stderr);
  return { code, ...output };
}

/** The published binary, for the one test that must see a real process boundary. */
export async function runClientBin(home: string, args: readonly string[]): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SUROWAN_ENDPOINT;
  delete env.SUROWAN_API_KEY;
  env.HOME = home;
  env.USERPROFILE = home;
  const result = await spawnCli(CLIENT_CLI, args, env);
  cliOutput.push(result.stdout, result.stderr);
  return result;
}

function spawnCli(bin: string, args: readonly string[], env: Record<string, string | undefined>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  });
}

export interface SignedRequestOptions {
  readonly clientId: string;
  readonly instanceId: string;
  readonly privateKey: KeyObject;
  readonly method: string;
  /** Path from `/api/…` plus query, exactly as the server will see it. */
  readonly target: string;
  readonly body?: string;
  readonly timestamp?: number;
  readonly nonce?: string;
}

/** Builds the header the client would send, so a test can tamper with any field. */
export function signatureHeader(options: SignedRequestOptions): string {
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body, 'utf8');
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? randomBytes(16).toString('base64url');
  const canonical = canonicalSignatureString({
    instanceId: options.instanceId,
    clientId: options.clientId,
    method: options.method,
    target: options.target,
    timestamp,
    nonce,
    bodyDigest: createHash('sha256').update(body).digest('base64url'),
  });
  const signature = sign(null, Buffer.from(canonical, 'utf8'), options.privateKey).toString('base64url');
  return formatSignatureAuthorization({ clientId: options.clientId, timestamp, nonce, signature });
}

export async function sendSigned(
  baseUrl: string,
  options: SignedRequestOptions & { readonly authorization?: string },
): Promise<Response> {
  const headers = new Headers({ authorization: options.authorization ?? signatureHeader(options) });
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return await fetch(new URL(options.target.replace(/^\/+/, ''), `${baseUrl}/`), {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    redirect: 'error',
  });
}

/** Signs the claim proof with a key that is not (yet) registered anywhere. */
export function pairingProof(code: string, identity: TestIdentity): string {
  const digest = createHash('sha256').update(code, 'utf8').digest('base64url');
  return sign(null, Buffer.from(pairingProofString(digest, identity.publicKey), 'utf8'), identity.privateKey).toString(
    'base64url',
  );
}

export async function claimPairing(
  baseUrl: string,
  body: { readonly code: string; readonly identity: TestIdentity; readonly proof?: string },
): Promise<Response> {
  return await fetch(`${baseUrl}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: body.code,
      public_key: body.identity.publicKey,
      proof: body.proof ?? pairingProof(body.code, body.identity),
    }),
  });
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object body, got HTTP ${response.status}`);
  }
  return parsed as Record<string, unknown>;
}

export function parseCliDocument(result: CliResult): Record<string, unknown> {
  expect(result.stderr, result.stderr).toBe('');
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the CLI did not print a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function pairingRow(store: SqliteStore, id: string) {
  return store.db
    .prepare<
      [bigint],
      {
        code_hash: string;
        public_key: string | null;
        consumed_at: string | null;
        canceled_at: string | null;
        client_id: bigint | null;
        expires_at: string;
      }
    >('SELECT code_hash, public_key, consumed_at, canceled_at, client_id, expires_at FROM admin_pairings WHERE id = ?')
    .get(BigInt(id));
}

export function clientRow(store: SqliteStore, id: string) {
  return store.db
    .prepare<
      [bigint],
      {
        name: string;
        public_key: string;
        fingerprint: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }
    >('SELECT name, public_key, fingerprint, created_at, last_used_at, revoked_at FROM admin_clients WHERE id = ?')
    .get(BigInt(id));
}

export function countRows(
  store: SqliteStore,
  table: 'admin_clients' | 'admin_pairings' | 'admin_client_nonces',
): number {
  const row = store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0n);
}

export function appStateValue(store: SqliteStore, key: string): string | undefined {
  return store.db.prepare<[string], { value: string }>('SELECT value FROM app_state WHERE key = ?').get(key)?.value;
}

/** Whole-table dump for "the code is never stored" style assertions. */
export function allRowsText(store: SqliteStore): string {
  const names = store.db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return names
    .map(({ name }) =>
      JSON.stringify(store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(), (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    .join('\n');
}
