import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import type { McpServerConfig } from '../../src/platform/config/index.ts';
import { createAdminAccount } from '../fixtures/admin-account.ts';
import type { SearchProviderRule } from '../../src/platform/web-search.ts';
import {
  type FixtureConfig,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  writeTestKeychain,
} from '../helpers.ts';

/** The real stdio MCP fixture the manager connects to; it advertises echo, wait and images. */
export const MCP_STDIO_FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function stdioFixtureServer(alias = 'stdio-fixture'): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, MCP_STDIO_FIXTURE],
    tools: ['echo'],
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }],
    // Unused while `tools` is an explicit list, but legal: removing it through
    // the panel must actually remove it (see the null-removal regression).
    default_tool_policy: { read_only: false, timeout_seconds: 60 },
  };
}

/**
 * A degraded-by-design HTTP server: port 1 on loopback refuses connections, so
 * the manager settles into `degraded` without any real network dependency.
 * The URL carries a path token and a query the way real MCP endpoints do, so
 * the programmatic-caller redaction has something to withhold.
 */
const httpFixtureServer: McpServerConfig = {
  alias: 'http-remote',
  transport: 'streamable_http',
  // A path token and a query the way hosted endpoints carry them: Zapier-style
  // `/mcp/<secret>/sse` paths and API keys in the query.
  url: 'http://127.0.0.1:1/mcp/mcp-path-secret?key=mcp-query-secret',
  follow_redirects: false,
  tools: '*',
  payload_max_bytes: 32_768,
  result_max_bytes: 32_768,
  headers: { authorization: { jar: 'mcp-header' } },
  // Wildcard servers may carry per-tool overrides next to the default policy.
  tool_policies: [{ name: 'query', read_only: true, timeout_seconds: 5 }],
  default_tool_policy: { read_only: true, timeout_seconds: 30 },
};

/** A plugin-style search provider the fixture can register, standing in for a deployment's own. */
export const CUSTOM_SEARCH_PROVIDER: SearchProviderRule = {
  id: 'custom-probe',
  label: 'Custom Probe',
  defaultEndpoint: 'https://probe.example.test/search',
  keyPolicy: 'forbidden',
  queryLimit: 100,
  supportsResultCount: false,
};

/** -100777 binds the stdio fixture explicitly; -100888 opts out; 123456789 inherits everything. */
function seedMcpSection(config: FixtureConfig): void {
  config.mcp = { servers: [stdioFixtureServer(), httpFixtureServer] };
  config.telegram.chats.push({ id: -100_777, mcp: [{ server: 'stdio-fixture' }] }, { id: -100_888, mcp: [] });
}

/** A `web_search` section that only the registered custom provider can validate. */
function seedCustomSearch(config: FixtureConfig): void {
  config.web_search = {
    enabled: true,
    engines: [
      {
        id: 'probe',
        provider: CUSTOM_SEARCH_PROVIDER.id,
        ...(CUSTOM_SEARCH_PROVIDER.defaultEndpoint === undefined
          ? {}
          : { endpoint: CUSTOM_SEARCH_PROVIDER.defaultEndpoint }),
      },
    ],
  };
}

export interface McpAdminFixture {
  readonly server: AdminServer;
  readonly store: SqliteStore;
  readonly configPath: string;
  readonly directory: string;
  readonly cookie: string;
  readonly manager: McpManager | null;
  /** The running configuration, for asserting what a write actually applied. */
  runtime(): RawConfig;
  read(): Promise<string>;
  file(): FixtureConfig;
  /** The plaintext `key.json` holds for a `{ jar }` SecretRef read from the file. */
  secret(reference: unknown): string | undefined;
  /** Resolves once every manager alias left `starting`; a no-op without one. */
  settled(): Promise<void>;
}

/**
 * A real `AdminServer` with a reloadable config seeded with one stdio fixture
 * server and one unreachable HTTP server, the way a small deployment looks.
 * With `manager: true` the servers also really connect, so the view reports
 * live state and the tools discovery returned.
 */
export async function mcpAdminFixture(
  options: { readonly manager?: boolean; readonly customSearch?: boolean } = {},
): Promise<McpAdminFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-mcp-'));
  directories.push(directory);
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
      seedMcpSection(config);
      if (options.customSearch === true) {
        seedCustomSearch(config);
      }
    }),
  );
  await writeTestKeychain(directory, { 'mcp-header': 'mcp-header-secret' });
  const searchProviders = options.customSearch === true ? [CUSTOM_SEARCH_PROVIDER] : undefined;
  const loaded: LoadedConfig = await loadConfig(configPath, {
    ...(searchProviders === undefined ? {} : { searchProviders }),
  });
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keychainPath(configPath));
  const configStore = await testConfigStore(loaded);
  const switcher = new AgentModelSwitcher(configStore);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    ...(searchProviders === undefined ? {} : { searchProviders }),
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const manager = options.manager === true ? new McpManager(store, loaded.config, secrets) : null;
  await manager?.start();
  const server = new AdminServer({
    store,
    configStore,
    configReloader: reloader,
    secrets,
    ...(options.customSearch === true ? { searchProviders: [CUSTOM_SEARCH_PROVIDER] } : {}),
    ...(manager === null
      ? {}
      : {
          mcpServerStates: () => manager.serverStates(),
          mcpServerTools: () => manager.serverToolListings(),
        }),
  });
  await createAdminAccount(store.orm, { username: 'owner', password: 'correct-horse-battery' });
  const setup = await server.handle(
    new Request('http://127.0.0.1:8899/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
    }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  const readJar = (): Record<string, { value: string }> =>
    (JSON.parse(readFileSync(join(directory, 'key.json'), 'utf8')) as { entries: Record<string, { value: string }> })
      .entries;
  return {
    server,
    store,
    configPath,
    directory,
    cookie,
    manager,
    runtime: () => configStore.current().config,
    read: () => readFile(configPath, 'utf8'),
    file: () => JSON.parse(readFileSync(configPath, 'utf8')) as FixtureConfig,
    secret: (reference) => {
      const name = (reference as { jar?: unknown } | undefined)?.jar;
      return typeof name === 'string' ? readJar()[name]?.value : undefined;
    },
    settled: async () => {
      if (manager !== null) {
        await awaitServerAttempts(manager);
      }
    },
  };
}

/** A programmatic bearer key, created through the panel session like an operator would. */
export async function bearerKey(fixture: McpAdminFixture, mode = 'read_write'): Promise<Record<string, string>> {
  const created = await fixture.server.handle(
    new Request('http://127.0.0.1:8899/api/api-keys', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: fixture.cookie,
        'if-match': await revisionOf(fixture),
      },
      body: JSON.stringify({ name: `mcp-${mode}`, mode }),
    }),
  );
  expect(created.status).toBe(200);
  const body = (await created.json()) as { key: string };
  return { authorization: `Bearer ${body.key}` };
}

export async function revisionOf(fixture: McpAdminFixture): Promise<string> {
  const response = await fixture.server.handle(
    new Request('http://127.0.0.1:8899/api/mcp-servers', { headers: { cookie: fixture.cookie } }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { revision: string }).revision;
}

/** One write response as the MCP server tests read it. */
export interface WriteResponse {
  readonly error?: string;
  readonly message?: string;
  readonly chats?: readonly string[];
  readonly revision?: string;
  readonly apply?: { readonly applied: readonly string[]; readonly restart_required: readonly string[] };
  readonly servers?: readonly { readonly alias: string; connection?: { url?: string; url_redacted?: boolean } }[];
}

/** A ready-to-submit streamable HTTP server body, shared by the write tests. */
export const httpServer = {
  alias: 'added-http',
  url: 'https://added.example.test/mcp',
  tools: '*',
  payload_max_bytes: 65_536,
  result_max_bytes: 16_384,
  default_tool_policy: { read_only: true, timeout_seconds: 25 },
};

/**
 * One MCP servers API call with the session cookie (or an explicit
 * Authorization header, which never reads the cookie) and a fresh revision.
 */
export async function write(
  fixture: McpAdminFixture,
  route: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: WriteResponse }> {
  const auth = Object.hasOwn(headers, 'authorization') ? {} : { cookie: fixture.cookie };
  const response = await fixture.server.handle(
    new Request(`http://127.0.0.1:8899/api${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(method === 'GET' ? {} : { 'if-match': await revisionOf(fixture) }),
        ...auth,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as WriteResponse };
}
