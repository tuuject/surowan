/**
 * The fixture configuration the E2E server runs on.
 *
 * Writes `config.jsonc`, the key jar and the models.dev catalog into the temp
 * directory, then loads them back: nothing here reads `dev-data/` or reaches the
 * network. The admin port is overridden to 0 in memory after a normal load
 * because production validation demands port >= 1 while tests bind an
 * OS-assigned one.
 */
import { join } from 'node:path';
import { type LoadedConfig, loadConfig } from '../../../src/adapters/local-monolith/config/index.ts';
import type { AdminConfig } from '../../../src/ingress/admin/index.ts';
import { loadModelsDevCatalog } from '../../../src/platform/models-dev.ts';
import { TEST_KEYCHAIN, testConfigJsonc, writeTestConfig, writeTestKeychain } from '../../../test/helpers.ts';
import { DOCS_KEYCHAIN, DOCS_MODELS, DOCS_PROVIDERS, requestedDocsSeed } from './docs-locale.ts';
import {
  E2E_BUILTIN_ALIAS,
  E2E_BUILTIN_PROVIDER,
  E2E_MERGE_ALIAS,
  E2E_MERGE_MODEL,
  E2E_MODELS_DEV_CATALOG,
  E2E_RELAY_ALIAS,
  E2E_SECRETS,
} from './models-fixture.ts';

export interface PreparedConfig {
  readonly loaded: LoadedConfig;
  /** The loaded config's admin block, with the bind port overridden to 0. */
  readonly adminConfig: AdminConfig;
}

/** The real stdio MCP fixture the page lists as a connected server. */
const MCP_STDIO_FIXTURE = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-server.ts');
const MCP_SKILLS_FIXTURE = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'mcp-skills-server.ts');

export async function prepareConfig(options: {
  readonly directory: string;
  readonly configPath: string;
  readonly staticDir: string;
  readonly relayPort: number;
}): Promise<PreparedConfig> {
  const { directory, configPath, staticDir, relayPort } = options;
  const docs = requestedDocsSeed();
  // Keychain entry names: the docs suite's screenshots show its own names, the
  // E2E suites keep the fixture names their assertions use.
  const jars =
    docs === null
      ? { relay: 'e2e-relay', relayHeader: 'e2e-relay-header', health: 'e2e-health', mcpHeader: 'e2e-mcp-header' }
      : {
          relay: DOCS_KEYCHAIN.relay,
          relayHeader: DOCS_KEYCHAIN.relayHeader,
          health: DOCS_KEYCHAIN.health,
          mcpHeader: DOCS_KEYCHAIN.mcpHeader,
        };
  const relayBaseUrl = `http://127.0.0.1:${String(relayPort)}/v1`;
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 1,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
      // A builtin provider with a model list: Pi supplies the address and the
      // adapter, the file supplies the enabled models.
      config.providers[E2E_BUILTIN_ALIAS] = {
        kind: 'builtin',
        provider: E2E_BUILTIN_PROVIDER,
        api_key: { jar: 'e2e-builtin' },
        models: [
          {
            id: 'openrouter/auto',
            name: 'Auto Router',
            reasoning: false,
            input: ['text'],
            context_window: 128_000,
            max_tokens: 8_192,
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        ],
      };
      config.providers[E2E_RELAY_ALIAS] = {
        kind: 'custom',
        base_url: `http://127.0.0.1:${String(relayPort)}/v1`,
        api: 'openai-completions',
        api_key: { jar: 'e2e-relay' },
        headers: { 'x-relay-token': { jar: 'e2e-relay-header' } },
        models: [
          {
            id: 'relay-existing-model',
            name: 'Relay Existing Model',
            reasoning: false,
            input: ['text', 'image'],
            context_window: 64_000,
            max_tokens: 4_096,
            cost: { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 },
          },
        ],
      };
      // The dictionary merge's Tool Model. Reasoning with two declared levels
      // so the Tool Model picker has a real choice to make; the same loopback
      // upstream answers its completions with a canned JSON suggestion.
      config.providers[E2E_MERGE_ALIAS] = {
        kind: 'custom',
        base_url: `http://127.0.0.1:${String(relayPort)}/v1`,
        api: 'openai-completions',
        api_key: { jar: 'e2e-relay' },
        models: [
          {
            id: E2E_MERGE_MODEL,
            name: 'Merge Tool Model',
            reasoning: true,
            thinking_levels: ['low', 'medium', 'high'],
            input: ['text'],
            context_window: 64_000,
            max_tokens: 4_096,
            cost: { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 },
          },
        ],
      };
      // The seeded `mascot` set is configured; the seeded `legacy` row stands
      // for a set removed earlier, whose index the store keeps.
      config.telegram.sticker_sets = [{ alias: 'mascot', name: 'surowan_mascot' }];
      // Two outbound MCP servers: the real stdio fixture (it connects and
      // advertises echo, wait and images, of which only echo is exposed) and an
      // unreachable HTTP endpoint that settles into `degraded`.
      config.mcp = {
        servers: [
          {
            alias: 'stdio-fixture',
            transport: 'stdio',
            command: [process.execPath, MCP_STDIO_FIXTURE.replaceAll('\\', '/')],
            tools: ['echo'],
            payload_max_bytes: 32_768,
            result_max_bytes: 32_768,
            tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }],
          },
          {
            // Publishes two verified skills ("demo" and "second").
            alias: 'skills-fixture',
            transport: 'stdio',
            command: [process.execPath, MCP_SKILLS_FIXTURE.replaceAll('\\', '/'), 'ok'],
            tools: ['ping'],
            payload_max_bytes: 32_768,
            result_max_bytes: 32_768,
            tool_policies: [{ name: 'ping', read_only: true, timeout_seconds: 20 }],
          },
          {
            alias: 'http-remote',
            transport: 'streamable_http',
            url: 'http://127.0.0.1:1/mcp',
            follow_redirects: false,
            tools: '*',
            payload_max_bytes: 32_768,
            result_max_bytes: 32_768,
            headers: { authorization: { jar: jars.mcpHeader } },
            default_tool_policy: { read_only: true, timeout_seconds: 30 },
          },
        ],
      };
      if (docs !== null) {
        // Documentation screenshots run on a clean, fully loopback registry: the
        // fake `example.test` providers would show up as broken connections, and
        // a builtin provider could reach the real internet on a health check.
        // These three providers answer from the local upstream and cover the
        // Agent, Vision and Tool model roles.
        config.providers = {
          [DOCS_PROVIDERS.relay]: {
            kind: 'custom',
            base_url: relayBaseUrl,
            api: 'openai-completions',
            api_key: { jar: jars.relay },
            headers: { 'x-relay-token': { jar: jars.relayHeader } },
            models: [
              {
                id: DOCS_MODELS.agent,
                name: docs.models.agent,
                reasoning: true,
                thinking_levels: ['low', 'medium', 'high'],
                input: ['text', 'image'],
                context_window: 200_000,
                max_tokens: 32_768,
                cost: { input: 0.5, output: 1.5, cache_read: 0.05, cache_write: 0.5 },
              },
              {
                id: DOCS_MODELS.vision,
                name: docs.models.vision,
                reasoning: false,
                input: ['text', 'image'],
                context_window: 128_000,
                max_tokens: 8_192,
                cost: { input: 0.2, output: 0.6, cache_read: 0.02, cache_write: 0.2 },
              },
            ],
          },
          [DOCS_PROVIDERS.health]: {
            kind: 'custom',
            base_url: relayBaseUrl,
            api: 'openai-completions',
            api_key: { jar: jars.health },
            models: [
              {
                id: DOCS_MODELS.health,
                name: docs.models.health,
                reasoning: false,
                input: ['text'],
                context_window: 64_000,
                max_tokens: 4_096,
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              },
            ],
          },
          [DOCS_PROVIDERS.tool]: {
            kind: 'custom',
            base_url: relayBaseUrl,
            api: 'openai-completions',
            api_key: { jar: jars.relay },
            models: [
              {
                id: DOCS_MODELS.tool,
                name: docs.models.tool,
                reasoning: false,
                input: ['text'],
                context_window: 64_000,
                max_tokens: 4_096,
                cost: { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 },
              },
            ],
          },
        };
        config.agent.provider = DOCS_PROVIDERS.relay;
        config.agent.model = DOCS_MODELS.agent;
        if (config.vision === undefined || config.vision === null) {
          throw new Error('The E2E fixture config has no vision block');
        }
        config.vision.provider = DOCS_PROVIDERS.relay;
        config.vision.model = DOCS_MODELS.vision;
        // Background helpers (dictionary merge, MCP description draft, image AI
        // extraction) call the Tool Model; the loopback upstream answers its id.
        config.tool_model = {
          provider: DOCS_PROVIDERS.tool,
          model: DOCS_MODELS.tool,
          thinking_level: 'off',
        };
      }
    }),
    docs?.globalPrompt,
    docs?.chatInstructions,
  );
  if (docs === null) {
    await writeTestKeychain(directory, {
      'e2e-builtin': E2E_SECRETS.builtin,
      'e2e-relay': E2E_SECRETS.relay,
      'e2e-relay-header': E2E_SECRETS.relayHeader,
      'e2e-mcp-header': 'e2e-mcp-header-secret',
    });
  } else {
    // The docs fixture owns its keychain: the entries the screenshots show as
    // used, plus one deliberately unused entry (the Keychain page's orphan).
    await writeTestKeychain(
      directory,
      {
        [DOCS_KEYCHAIN.telegram]: TEST_KEYCHAIN.telegram,
        [DOCS_KEYCHAIN.relay]: E2E_SECRETS.relay,
        [DOCS_KEYCHAIN.relayHeader]: E2E_SECRETS.relayHeader,
        [DOCS_KEYCHAIN.health]: E2E_SECRETS.health,
        [DOCS_KEYCHAIN.mcpHeader]: 'e2e-mcp-header-secret',
        [DOCS_KEYCHAIN.unused]: 'unused-example-key',
      },
      { replace: true, createdAt: '2026-09-01T08:00:00.000Z' },
    );
  }
  // `discover` and `lookup-metadata` resolve metadata against the models.dev
  // catalog. Priming it with a fixture (the module's own test seam) keeps the
  // E2E server offline.
  await loadModelsDevCatalog({
    ttlMs: 60 * 60 * 1000,
    fetchImpl: () => Promise.resolve(Response.json(E2E_MODELS_DEV_CATALOG)),
  });
  const loaded: LoadedConfig = await loadConfig(configPath);
  const adminConfig = loaded.config.admin;
  if (adminConfig === undefined) {
    throw new Error('Admin config is missing from the E2E config');
  }
  // Production validation demands port >= 1; tests bind an OS-assigned port
  // by overriding to 0 in memory after a normal load. Both layers are
  // overridden: the reloader keeps a clone of the file layer as its active
  // configuration, so only changing the raw layer would make the next reload
  // adopt the file's port and hide the pending `admin.port` change.
  adminConfig.port = 0;
  if (loaded.fileConfig.admin !== undefined) {
    loaded.fileConfig.admin.port = 0;
  }
  return { loaded, adminConfig };
}
