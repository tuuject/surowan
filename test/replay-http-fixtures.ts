import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxProvider } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { expect } from 'vitest';
import { createExecuteTool } from '../src/capabilities/execute-tool.ts';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { AdminQueryError } from '../src/ingress/admin/audit.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { ReplayError, ReplayRunner } from '../src/orchestration/replay.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { snapshotInvocation } from '../src/store/invocation-snapshot.ts';
import { bucketMessages, invocationMessages, messageRevisions, messages } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * End-to-end CLI -> real HTTP AdminServer -> ReplayRunner integration.
 *
 * The AdminServer is wired exactly like `serve` wires it: the host callback
 * invokes a real ReplayRunner and converts ReplayError to AdminQueryError with
 * the same code/status. A faux provider stands in for the model, so every
 * asserted side effect is synthetic and nothing reaches Telegram or a network.
 */

const PASSWORD = 'integration-panel-password';
const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));

const cleanup: Array<() => Promise<void>> = [];

/** Drops every fixture built by this test file; register it via `afterEach`. */
export async function cleanupFixtures(): Promise<void> {
  for (const close of cleanup.splice(0)) {
    await close();
  }
}

const definition = (name: string, parameters = Type.Object({})) => ({
  name,
  label: name,
  description: `fixture ${name}`,
  parameters,
});
export const OVERRIDE_PROMPT = 'You are the overridden replay prompt.';
function sceneRegistry() {
  return {
    tools: [
      definition('send', SendInputSchema),
      createExecuteTool({
        capabilities: [],
        audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
      }),
      definition('zzz'),
      definition('mcp_remote_write'),
    ],
    capabilities: [
      {
        ...definition('add_memory', AddMemoryInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
      {
        ...definition('alarm', AlarmInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
      {
        ...definition('list_alarm', ListAlarmInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
    ],
  };
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-replay-http-'));
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
  const loaded = await loadConfig(configPath);
  const admin = loaded.config.admin;
  if (admin === undefined) {
    throw new Error('fixture config has no admin block');
  }
  // The config schema pins admin.port >= 1; the in-memory snapshot uses 0 so
  // the real listener binds an OS-assigned loopback port for this test.
  admin.port = 0;
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', contextWindow: 200_000, maxTokens: 128 }],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const seed = seedAdminFixture(store);
  const opening = seed.messageIds[1]!;
  store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, seed.invocationA)).run();
  store.orm
    .insert(bucketMessages)
    .values({ bucketId: seed.bucketA, messageId: opening, sourceBucketId: seed.bucketA, sequenceNo: 1n })
    .run();
  // Align this synthetic seed with a real freeze moment. The writer itself
  // supplies complete snapshots; no historical model payload is installed.
  store.orm
    .update(messages)
    .set({ telegramDate: '2026-09-10T07:59:40.000Z', receivedAt: '2026-09-10T07:59:40.000Z' })
    .where(eq(messages.id, opening))
    .run();
  const revision = store.orm
    .select({ id: messageRevisions.id })
    .from(messageRevisions)
    .where(eq(messageRevisions.messageId, opening))
    .orderBy(messageRevisions.revisionNo)
    .get()!;
  store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, opening)).run();
  store.orm
    .update(messageRevisions)
    .set({ createdAt: '2026-09-10T07:59:40.000Z' })
    .where(eq(messageRevisions.id, revision.id))
    .run();
  snapshotInvocation(store, 0, seed.invocationA, seed.bucketA, seed.conversationId, false);
  const builder = new ContextBuilder(
    store,
    new ContextRefStore(store, { ttlHours: () => loaded.config.agent!.context!.ref_ttl_hours }),
  );
  const stable = builder.buildSystemPrompt(loaded.config, builder.identity(loaded.config, seed.invocationA), false, {
    provider: 'agent',
    model: 'agent-model',
  });
  const secrets = new SecretStore();
  const shutdown = new AbortController();
  const gate = new KeyedSemaphore();
  const runner = new ReplayRunner({
    store,
    configStore,
    secrets,
    systemResources: emptySystemResources(),
    modelGate: gate,
    shutdownSignal: shutdown.signal,
    toolDefinitions: () => sceneRegistry(),
  });
  // Same wiring as `serve` in src/application.ts: ReplayError becomes an
  // AdminQueryError with the engine's code and status, anything else is 500.
  const toAdminQueryError = (error: unknown): never => {
    if (error instanceof ReplayError) {
      throw new AdminQueryError(error.code, error.message, error.status);
    }
    throw error;
  };
  const server = new AdminServer({
    store,
    configStore,
    secrets,
    replayPreflight: (id, selection) => {
      try {
        return runner.inspect(id, selection);
      } catch (error) {
        return toAdminQueryError(error);
      }
    },
    invocationPrompts: (id) => {
      try {
        return runner.prompts(id);
      } catch (error) {
        return toAdminQueryError(error);
      }
    },
    replayInvocation: async (id, input, signal) => {
      try {
        return await runner.run(id, input, signal);
      } catch (error) {
        if (error instanceof ReplayError) {
          throw new AdminQueryError(error.code, error.message, error.status);
        }
        throw error;
      }
    },
  });
  const listening = await server.start();
  cleanup.push(async () => {
    shutdown.abort(new Error('test shutdown'));
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const clearScene = () =>
    store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, seed.invocationA)).run();
  const rows = () => stateRows(store);
  return {
    directory,
    loaded,
    faux,
    configStore,
    store,
    seed,
    secrets,
    listening,
    baseUrl: `http://127.0.0.1:${listening.port}`,
    clearScene,
    stable,
    rows,
  };
}

/** Every non-internal table and all of its rows, for before/after comparison. */
function stateRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

/** The API key layer records use, which is the one expected auth write. */
export function productionTables(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(rows).filter(([name]) => name !== 'admin_api_keys'));
}

/** Session-authenticated reads also update the existing session activity clock. */
export function expectSessionActivityOnly(before: Record<string, unknown[]>, after: Record<string, unknown[]>): void {
  expect(after).toEqual({
    ...before,
    admin_sessions: before.admin_sessions?.map((row) => ({
      ...(row as Record<string, unknown>),
      last_seen_at: expect.any(String),
    })),
  });
}

/** SQLite INTEGER columns come back as bigint; JSON needs a string form to search. */
export function stringifyRows(rows: unknown): string {
  return JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

export function apiKeyRow(store: SqliteStore, id: string) {
  return store.db
    .prepare<[bigint], { token_hash: string; last_used_at: string | null; revoked_at: string | null }>(
      'SELECT token_hash, last_used_at, revoked_at FROM admin_api_keys WHERE id = ?',
    )
    .get(BigInt(id));
}

export async function asObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object body, got HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

export interface AdminSessionFixture {
  readonly cookie: string;
  /** Plaintext key: fixture-only, never printed by this test. */
  readonly key: string;
  readonly keyId: string;
}

/** Real HTTP: unauthenticated session check, first-user setup, then key creation. */
export async function setupAdminSession(baseUrl: string): Promise<AdminSessionFixture> {
  const session = await fetch(`${baseUrl}/api/auth/session`);
  expect(session.status).toBe(200);
  expect(await asObject(session)).toMatchObject({ setup_required: true, authenticated: false, username: null });

  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  });
  expect(setup.status).toBe(200);
  const setCookie = setup.headers.get('set-cookie');
  if (setCookie === null || setCookie.length === 0) {
    throw new Error('admin setup returned no session cookie');
  }
  const cookie = setCookie.slice(0, setCookie.indexOf(';'));

  const confirmed = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  expect(await asObject(confirmed)).toMatchObject({ setup_required: false, authenticated: true, username: 'owner' });

  const createdResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'replay-http-integration' }),
  });
  expect(createdResponse.status).toBe(200);
  const created = await asObject(createdResponse);
  expect(created.item).toMatchObject({
    id: expect.stringMatching(/^\d+$/),
    name: 'replay-http-integration',
    prefix: expect.stringMatching(/^pwk_[A-Za-z0-9_-]{8}$/),
    created_at: expect.any(String),
    last_used_at: null,
    revoked_at: null,
  });
  const key = created.key;
  if (typeof key !== 'string') {
    throw new Error('key creation did not return a plaintext key');
  }
  // The secret exists only in the create response, never in the item metadata.
  expect(JSON.stringify(created.item)).not.toContain(key);
  const item = created.item as { readonly id: string };
  return { cookie, key, keyId: item.id };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The real CLI bin as a child process; the API key travels by environment only. */
export function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.SUROWAN_ENDPOINT;
  delete childEnv.SUROWAN_API_KEY;
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
