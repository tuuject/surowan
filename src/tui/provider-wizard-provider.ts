import { input, select } from '@inquirer/prompts';
import { findBuiltinProvider, listBuiltinPresets, supportedBuiltinApi } from '../platform/builtin-providers.ts';
import type { SecretRef } from '../platform/config.ts';
import { type DiscoveredProviderModel, planModelsEndpoint } from '../platform/provider-models.ts';
import { type ApiAdapter, promptApiAdapter, promptSecretRef, promptString } from './prompts.ts';
import { discoverProviderModels, runModelWizard, searchChoice, validateBaseUrl } from './provider-wizard-model.ts';
import type {
  AddProviderKindAction,
  BuiltinProviderConfig,
  BuiltinProviderField,
  CustomProviderDraftField,
  CustomProviderField,
  ModelConfig,
  ProviderConfig,
} from './provider-wizard-support.ts';

export async function selectProviderAlias(providers: Record<string, ProviderConfig>): Promise<string | undefined> {
  const aliases = Object.keys(providers);
  if (aliases.length === 0) {
    return undefined;
  }
  return searchChoice(
    'Select provider',
    aliases.map((alias) => ({
      value: alias,
      name: describeProvider(alias, providers[alias] as ProviderConfig),
    })),
  );
}

function describeProvider(alias: string, provider: ProviderConfig): string {
  if (provider.kind === 'builtin') {
    return `${alias} (built-in: ${provider.provider})`;
  }
  return `${alias} (custom: ${provider.api})`;
}

export async function addProvider(keyJar: string): Promise<{ alias: string; config: ProviderConfig } | undefined> {
  let alias = '';
  aliasStep: while (true) {
    alias = await input({
      message: 'Provider alias',
      ...(alias === '' ? {} : { default: alias }),
      validate: (value) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || 'Invalid alias',
    });
    while (true) {
      const kind = await select<AddProviderKindAction>({
        message: 'Provider kind',
        choices: [
          { value: 'builtin', name: 'Built-in provider (uses Pi AI model catalog)' },
          { value: 'custom', name: 'Custom provider (OpenAI/Anthropic-compatible endpoint)' },
          { value: 'back', name: 'Back to provider alias' },
          { value: 'cancel', name: 'Cancel adding provider' },
        ],
      });
      if (kind === 'back') {
        continue aliasStep;
      }
      if (kind === 'cancel') {
        return undefined;
      }
      const config =
        kind === 'builtin' ? await configureBuiltinProvider(keyJar) : await configureCustomProvider(keyJar);
      if (config !== undefined) {
        return { alias, config };
      }
    }
  }
}

/**
 * A builtin provider registers exactly the models written here: Pi's catalog
 * decides which ids may be configured, never which are reachable at runtime.
 */
async function configureBuiltinProvider(keyJar: string): Promise<ProviderConfig | undefined> {
  const providers = listBuiltinPresets();
  let providerId: string | undefined;
  let apiKey: SecretRef | undefined;
  let models: ModelConfig[] = [];
  let discoveredModels: DiscoveredProviderModel[] = [];
  while (true) {
    const source = providerId === undefined ? undefined : findBuiltinProvider(providerId);
    const api = source === undefined ? null : supportedBuiltinApi(source);
    const readyToDiscover =
      source !== undefined && api !== null && source.baseUrl !== undefined && apiKey !== undefined;
    const readyToSave = providerId !== undefined && apiKey !== undefined && models.length > 0;
    const action = await select<BuiltinProviderField>({
      message: 'Add built-in provider',
      choices: [
        { value: 'provider', name: `Built-in provider: ${providerId ?? 'not set'}` },
        { value: 'api_key', name: `API key: ${apiKey === undefined ? 'not set' : 'configured'}` },
        {
          value: 'discover',
          name: `Fetch models from ${readyToDiscover ? planModelsEndpoint({ ...(providerId === undefined ? {} : { builtinProvider: providerId }), baseUrl: source.baseUrl, api }).endpoint : 'the provider /models endpoint'}`,
          disabled: readyToDiscover ? false : 'Select a provider and configure its API key first',
        },
        { value: 'models', name: `Models (${models.length}; ${discoveredModels.length} fetched)` },
        {
          value: 'save',
          name: 'Add provider',
          disabled: readyToSave ? false : 'Select a provider, configure its API key, and add at least one model',
        },
        { value: 'back', name: 'Back to provider kind' },
      ],
    });
    switch (action) {
      case 'provider': {
        providerId = await searchChoice(
          'Built-in provider',
          providers.map((provider) => ({
            value: provider.id,
            name: `${provider.name} (${provider.id})`,
          })),
        );
        discoveredModels = [];
        break;
      }
      case 'api_key':
        apiKey = await promptSecretRef('API key', keyJar);
        discoveredModels = [];
        break;
      case 'discover':
        if (source !== undefined && api !== null && source.baseUrl !== undefined && apiKey !== undefined) {
          discoveredModels = await discoverProviderModels(
            {
              ...(providerId === undefined ? {} : { builtinProvider: providerId }),
              baseUrl: source.baseUrl,
              api,
              apiKey,
            },
            keyJar,
          );
        }
        break;
      case 'models':
        models = await runModelWizard(models, discoveredModels);
        break;
      case 'save':
        if (providerId !== undefined && apiKey !== undefined && models.length > 0) {
          return { kind: 'builtin', provider: providerId, api_key: apiKey, models };
        }
        break;
      default:
        return undefined;
    }
  }
}

async function configureCustomProvider(keyJar: string): Promise<ProviderConfig | undefined> {
  let baseUrl: string | undefined;
  let api: ApiAdapter | undefined;
  let apiKey: SecretRef | undefined;
  let headers: Record<string, SecretRef> = {};
  let models: ModelConfig[] = [];
  let discoveredModels: DiscoveredProviderModel[] = [];
  while (true) {
    const readyToDiscover = baseUrl !== undefined && api !== undefined && apiKey !== undefined;
    const readyToSave = readyToDiscover && models.length > 0;
    const action = await select<CustomProviderDraftField>({
      message: 'Add custom provider',
      choices: [
        { value: 'base_url', name: `Base URL: ${baseUrl ?? 'not set'}` },
        { value: 'api', name: `API adapter: ${api ?? 'not set'}` },
        { value: 'api_key', name: `API key: ${apiKey === undefined ? 'not set' : 'configured'}` },
        { value: 'headers', name: `Custom headers (${Object.keys(headers).length})` },
        {
          value: 'discover',
          name: `Fetch models from ${baseUrl === undefined ? 'the provider /models endpoint' : planModelsEndpoint({ baseUrl, api: api ?? 'openai-completions' }).endpoint}`,
          disabled: readyToDiscover ? false : 'Configure the Base URL, API adapter, and API key first',
        },
        { value: 'models', name: `Models (${models.length}; ${discoveredModels.length} fetched)` },
        {
          value: 'save',
          name: 'Add provider',
          disabled: readyToSave ? false : 'Configure the endpoint, API key, and at least one model first',
        },
        { value: 'back', name: 'Back to provider kind' },
      ],
    });
    switch (action) {
      case 'base_url':
        baseUrl = await input({
          message: 'Base URL',
          ...(baseUrl === undefined ? {} : { default: baseUrl }),
          validate: validateBaseUrl,
        });
        discoveredModels = [];
        break;
      case 'api':
        api = await promptApiAdapter();
        discoveredModels = [];
        break;
      case 'api_key':
        apiKey = await promptSecretRef('API key', keyJar);
        discoveredModels = [];
        break;
      case 'headers':
        headers = await editHeaders(headers, keyJar);
        discoveredModels = [];
        break;
      case 'discover':
        if (baseUrl !== undefined && api !== undefined && apiKey !== undefined) {
          discoveredModels = await discoverProviderModels({ baseUrl, api, apiKey, headers }, keyJar);
        }
        break;
      case 'models':
        models = await runModelWizard(models, discoveredModels);
        break;
      case 'save':
        if (baseUrl !== undefined && api !== undefined && apiKey !== undefined && models.length > 0) {
          return {
            kind: 'custom',
            base_url: baseUrl,
            api,
            api_key: apiKey,
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
            models,
          };
        }
        break;
      default:
        return undefined;
    }
  }
}

export async function editProvider(provider: ProviderConfig, keyJar: string): Promise<ProviderConfig | undefined> {
  if (provider.kind === 'builtin') {
    return await editBuiltinProvider(provider, keyJar);
  }
  let updated: ProviderConfig = { ...provider };
  const action = await select<CustomProviderField>({
    message: 'Edit custom provider',
    choices: [
      { value: 'base_url', name: `Base URL: ${updated.base_url}` },
      { value: 'api', name: `API adapter: ${updated.api}` },
      { value: 'api_key', name: 'API key' },
      { value: 'headers', name: `Custom headers (${Object.keys(updated.headers ?? {}).length})` },
      { value: 'models', name: `Models (${updated.models.length})` },
      { value: 'cancel', name: 'Cancel' },
    ],
  });
  switch (action) {
    case 'base_url': {
      const baseUrl = await promptString('Base URL', updated.base_url);
      updated = { ...updated, base_url: baseUrl };
      break;
    }
    case 'api': {
      const api = await promptApiAdapter();
      updated = { ...updated, api };
      break;
    }
    case 'api_key': {
      updated = { ...updated, api_key: await promptSecretRef('API key', keyJar) };
      break;
    }
    case 'headers': {
      updated = { ...updated, headers: await editHeaders(updated.headers ?? {}, keyJar) };
      break;
    }
    case 'models': {
      updated = { ...updated, models: await runModelWizard(updated.models) };
      break;
    }
    default:
      return undefined;
  }
  return updated;
}

async function editBuiltinProvider(
  provider: BuiltinProviderConfig,
  keyJar: string,
): Promise<ProviderConfig | undefined> {
  const action = await select<'api_key' | 'models' | 'cancel'>({
    message: `Edit built-in provider (${provider.provider})`,
    choices: [
      { value: 'api_key', name: 'API key' },
      { value: 'models', name: `Models (${provider.models.length})` },
      { value: 'cancel', name: 'Cancel' },
    ],
  });
  switch (action) {
    case 'api_key':
      return { ...provider, api_key: await promptSecretRef('API key', keyJar) };
    case 'models': {
      const source = findBuiltinProvider(provider.provider);
      const api = source === undefined ? null : supportedBuiltinApi(source);
      const discovered =
        source !== undefined && api !== null && source.baseUrl !== undefined
          ? await discoverProviderModels(
              {
                builtinProvider: provider.provider,
                baseUrl: source.baseUrl,
                api,
                apiKey: provider.api_key,
              },
              keyJar,
            )
          : [];
      const models = await runModelWizard(provider.models, discovered);
      if (models.length === 0) {
        console.error('A built-in provider needs at least one configured model');
        return undefined;
      }
      return { ...provider, models };
    }
    default:
      return undefined;
  }
}

async function editHeaders(headers: Record<string, SecretRef>, keyJar: string): Promise<Record<string, SecretRef>> {
  const choices: { value: string; name: string }[] = [
    { value: '__add', name: 'Add header' },
    ...Object.entries(headers).map(([name]) => ({ value: name, name: `Edit "${name}"` })),
    ...Object.entries(headers).map(([name]) => ({ value: `__delete:${name}`, name: `Delete "${name}"` })),
    { value: '__back', name: 'Done' },
  ];
  const action = await select<string>({ message: 'Custom headers', choices });
  if (action === '__back') {
    return headers;
  }
  if (action === '__add') {
    const name = await input({ message: 'Header name', validate: (value) => value.trim().length > 0 || 'Required' });
    const value = await promptSecretRef(`Value for "${name}"`, keyJar);
    return { ...headers, [name]: value };
  }
  if (action.startsWith('__delete:')) {
    const name = action.slice('__delete:'.length);
    const { [name]: _, ...rest } = headers;
    return rest;
  }
  const value = await promptSecretRef(`Value for "${action}"`, keyJar);
  return { ...headers, [action]: value };
}
