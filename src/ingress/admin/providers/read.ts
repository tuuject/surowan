/**
 * Provider reads and the shared lookups the write and discovery paths reuse:
 * the panel's provider list, presets, and the per-model API resolution.
 */
import { findBuiltinProvider, listBuiltinPresets, supportedBuiltinApi } from '../../../platform/builtin-providers.ts';
import type { AgentSettings, FileConfig, ModelFileConfig, ProviderApi } from '../../../platform/config/index.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import { AdminQueryError } from '../audit/shared.ts';
import type { ProviderPresetView, ProvidersView } from './index.ts';
import { assertModelConfig, resolveBuiltinModelApi } from '../../../platform/config/semantics.ts';

export function supervisedRestartEnabled(): boolean {
  return process.env.PLASTICWAN_SUPERVISED === '1';
}

export function listProviders(
  file: Pick<FileConfig, 'providers' | 'vision' | 'tool_model'> & {
    agent?: AgentSettings | null;
  },
  revision: string,
  restartRequired: readonly string[],
): ProvidersView {
  const configuredToolModel = file.tool_model;
  return {
    revision,
    supervised: supervisedRestartEnabled(),
    agent: {
      provider: file.agent?.provider ?? null,
      model: file.agent?.model ?? null,
      thinking_level: file.agent?.thinking_level ?? null,
    },
    vision: { provider: file.vision?.provider ?? null, model: file.vision?.model ?? null },
    tool_model:
      configuredToolModel === undefined
        ? {
            provider: file.agent?.provider ?? null,
            model: file.agent?.model ?? null,
            thinking_level: file.agent?.thinking_level ?? null,
            inherited: true,
          }
        : { ...configuredToolModel, inherited: false },
    restart_required: [...restartRequired],
    providers: Object.entries(file.providers).map(([alias, provider]) => {
      if (provider.kind === 'custom') {
        return {
          alias,
          kind: 'custom' as const,
          api: provider.api,
          base_url: provider.base_url,
          header_names: Object.keys(provider.headers ?? {}),
          models: provider.models,
        };
      }
      const source = findBuiltinProvider(provider.provider);
      const api = source === undefined ? null : configuredBuiltinApi(alias, provider);
      if (source === undefined || api === null || source.baseUrl === undefined) {
        // `loadConfig` rejects this, so the panel only sees it if the file was
        // edited between the load and this response.
        throw new AdminQueryError(
          'provider_unsupported',
          `Built-in provider ${provider.provider} has no supported API adapter`,
          422,
        );
      }
      return {
        alias,
        kind: 'builtin' as const,
        provider: provider.provider,
        api,
        base_url: source.baseUrl,
        header_names: [],
        models: provider.models,
      };
    }),
  };
}

export function listProviderPresets(): readonly ProviderPresetView[] {
  const presets: ProviderPresetView[] = [];
  for (const source of listBuiltinPresets()) {
    const api = supportedBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      continue;
    }
    presets.push({ id: source.id, name: source.name, api, base_url: source.baseUrl });
  }
  return presets;
}

export function providerOf(file: FileConfig, alias: string): FileConfig['providers'][string] {
  const provider = file.providers[alias];
  if (provider === undefined) {
    throw new AdminQueryError('provider_not_found', `Provider ${alias} is not configured`, 404);
  }
  return provider;
}

/**
 * The API one configured model speaks, for compat applicability checks.
 * Custom providers state it; builtin ones resolve it per model from Pi's
 * catalog (pi 1.x catalogs mix chat adapters inside one provider).
 */
export function modelApi(alias: string, provider: FileConfig['providers'][string], modelId: string): ProviderApi {
  if (provider.kind === 'custom') {
    return provider.api;
  }
  return resolveBuiltinModelApi(alias, provider, modelId);
}

/**
 * The listing API for discovery against a configured alias. A uniform catalog
 * keeps its api; a mixed-catalog provider (pi 1.x OpenRouter, …) lists models
 * through its OpenAI-shaped directory, not through any single chat adapter.
 */
export function discoveryApi(provider: FileConfig['providers'][string]): ProviderApi {
  if (provider.kind === 'custom') {
    return provider.api;
  }
  const source = findBuiltinProvider(provider.provider);
  const uniform = source === undefined ? null : supportedBuiltinApi(source);
  if (uniform !== null) {
    return uniform;
  }
  if (source === undefined) {
    throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${provider.provider}`, 422);
  }
  return 'openai-completions';
}

/**
 * The api shown for a configured builtin alias: the uniform catalog api, or —
 * on a mixed-catalog provider — the first configured model's catalog api.
 */
function configuredBuiltinApi(
  alias: string,
  provider: FileConfig['providers'][string] & { kind: 'builtin' },
): ProviderApi | null {
  const source = findBuiltinProvider(provider.provider);
  const uniform = source === undefined ? null : supportedBuiltinApi(source);
  if (uniform !== null) {
    return uniform;
  }
  const first = provider.models[0];
  if (first === undefined) {
    return null;
  }
  try {
    return resolveBuiltinModelApi(alias, provider, first.id);
  } catch {
    return null;
  }
}

export function checkModel(api: ProviderApi, model: ModelFileConfig, label: string): void {
  try {
    assertModelConfig(api, model, label);
  } catch (error) {
    throw new AdminQueryError('invalid_model', error instanceof Error ? error.message : String(error));
  }
}

/**
 * A plaintext secret is registered with the `SecretStore` before it is written
 * or sent anywhere: until it is, redaction cannot mask it in logs, reload errors
 * or upstream failures. Submissions are remembered rather than resolved, so a
 * value that arrived with a request cannot pile up in the process-wide set.
 */
export function registerSecrets(secrets: SecretStore, values: readonly string[]): void {
  for (const value of values) {
    secrets.remember(value);
  }
}
