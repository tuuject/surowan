/**
 * The fixture configuration the E2E server runs on.
 *
 * Writes `config.jsonc`, the key jar and the models.dev catalog into the temp
 * directory, then loads them back: nothing here reads `dev-data/` or reaches the
 * network. The admin port is overridden to 0 in memory after a normal load
 * because production validation demands port >= 1 while tests bind an
 * OS-assigned one.
 */
import { type LoadedConfig, loadConfig } from '../../../src/adapters/local-monolith/config/index.ts';
import type { AdminConfig } from '../../../src/ingress/admin/index.ts';
import { loadModelsDevCatalog } from '../../../src/platform/models-dev.ts';
import { testConfigJsonc, writeTestConfig, writeTestKeyJar } from '../../../test/helpers.ts';
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

export async function prepareConfig(options: {
  readonly directory: string;
  readonly configPath: string;
  readonly staticDir: string;
  readonly relayPort: number;
}): Promise<PreparedConfig> {
  const { directory, configPath, staticDir, relayPort } = options;
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
    }),
  );
  await writeTestKeyJar(directory, {
    'e2e-builtin': E2E_SECRETS.builtin,
    'e2e-relay': E2E_SECRETS.relay,
    'e2e-relay-header': E2E_SECRETS.relayHeader,
  }); // `discover` and `lookup-metadata` resolve metadata against the models.dev
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
