import { confirm, input, search, select } from '@inquirer/prompts';
import type { SecretRef, ThinkingLevelConfig } from '../platform/config.ts';
import {
  fetchModelsDevCatalog,
  findModel,
  listModels as listModelsDevModels,
  listProviders as listModelsDevProviders,
  type ModelsDevCatalog,
  type ModelsDevModel,
  toModelDefaults,
} from '../platform/models-dev.ts';
import { assertBaseUrl, type DiscoveredProviderModel, fetchProviderModels } from '../platform/provider-models.ts';
import { SecretStore } from '../platform/secrets.ts';
import {
  type ApiAdapter,
  promptInputCapabilities,
  promptNonNegativeNumber,
  promptPositiveInteger,
  promptString,
} from './prompts.ts';
import {
  filterSearchChoices,
  type ModelAction,
  type ModelConfig,
  type ModelField,
  type SearchChoice,
} from './provider-wizard-support.ts';

export async function runModelWizard(
  models: ModelConfig[],
  discoveredModels: readonly DiscoveredProviderModel[] = [],
): Promise<ModelConfig[]> {
  let current = [...models];
  let exit = false;
  while (!exit) {
    const configuredIds = new Set(current.map((model) => model.id));
    const availableDiscoveredModels = discoveredModels.filter((model) => !configuredIds.has(model.id));
    const choices: { value: ModelAction; name: string }[] = [{ value: 'add', name: 'Add model ID manually' }];
    if (availableDiscoveredModels.length > 0) {
      choices.push({ value: 'discover', name: `Add fetched model (${availableDiscoveredModels.length} available)` });
    }
    if (current.length > 0) {
      choices.push({ value: 'edit', name: 'Edit model' });
      choices.push({ value: 'delete', name: 'Delete model' });
    }
    choices.push({ value: 'back', name: 'Done' });
    const action = await select<ModelAction>({ message: `Models (${current.length})`, choices });
    switch (action) {
      case 'add': {
        const model = await addModel();
        if (model !== undefined) {
          if (configuredIds.has(model.id)) {
            console.error(`Model "${model.id}" is already configured`);
          } else {
            current = [...current, model];
          }
        }
        break;
      }
      case 'discover': {
        const discovered = await searchChoice(
          'Fetched model',
          availableDiscoveredModels.map((model) => ({
            value: model,
            name: model.name === null ? model.id : `${model.name} (${model.id})`,
          })),
        );
        const model = await addModel(discovered.id);
        if (model !== undefined) {
          current = [...current, model];
        }
        break;
      }
      case 'edit': {
        const index = await selectModelIndex(current);
        const toEdit = index !== undefined ? current[index] : undefined;
        if (toEdit !== undefined) {
          const model = await editModel(toEdit);
          if (model !== undefined) {
            current = current.map((m, i) => (i === index ? model : m));
          }
        }
        break;
      }
      case 'delete': {
        const index = await selectModelIndex(current);
        const toDelete = index !== undefined ? current[index] : undefined;
        if (toDelete !== undefined && (await confirm({ message: `Delete model "${toDelete.id}"?` }))) {
          current = current.filter((_, i) => i !== index);
        }
        break;
      }
      default:
        exit = true;
        break;
    }
  }
  return current;
}

async function selectModelIndex(models: ModelConfig[]): Promise<number | undefined> {
  return searchChoice(
    'Select model',
    models.map((model, i) => ({ value: i, name: `${model.id} (${model.name ?? model.id})` })),
  );
}

async function addModel(initialId?: string): Promise<ModelConfig | undefined> {
  const id =
    initialId ??
    (
      await input({
        message: 'Model ID',
        validate: (value) => value.trim().length > 0 || 'Required',
      })
    ).trim();
  const useModelsDev = await confirm({ message: 'Look up model metadata from models.dev?', default: true });
  let defaults:
    | {
        name: string;
        reasoning: boolean;
        input: Array<'text' | 'image'>;
        context_window: number;
        max_tokens: number;
        cost: { input: number; output: number; cache_read: number; cache_write: number };
        thinking_levels: ThinkingLevelConfig[] | null;
      }
    | undefined;
  if (useModelsDev) {
    defaults = await lookupModelDefaults(id);
  }
  const name = (await promptString('Display name (optional)', defaults?.name ?? id, false)) || id;
  const reasoning = await confirm({ message: 'Supports reasoning', default: defaults?.reasoning ?? false });
  const capabilities = await promptInputCapabilities(defaults?.input ?? ['text']);
  const contextWindow = await promptPositiveInteger('Context window (tokens)', defaults?.context_window ?? 128000);
  const maxTokens = await promptPositiveInteger('Max output tokens', defaults?.max_tokens ?? 4096);
  if (maxTokens > contextWindow) {
    console.error('Max output tokens cannot exceed context window');
    return undefined;
  }
  const costInput = await promptNonNegativeNumber('Input cost per 1M tokens', defaults?.cost.input ?? 0);
  const costOutput = await promptNonNegativeNumber('Output cost per 1M tokens', defaults?.cost.output ?? 0);
  const costCacheRead = await promptNonNegativeNumber('Cache read cost per 1M tokens', defaults?.cost.cache_read ?? 0);
  const costCacheWrite = await promptNonNegativeNumber(
    'Cache write cost per 1M tokens',
    defaults?.cost.cache_write ?? 0,
  );
  // Levels come from models.dev only; without them the model runs on Pi's default.
  const thinkingLevels = reasoning ? (defaults?.thinking_levels ?? null) : null;
  if (thinkingLevels !== null) {
    console.log(`Thinking levels from models.dev: ${thinkingLevels.join(', ')}`);
  }
  return {
    id,
    name,
    reasoning,
    ...(thinkingLevels === null ? {} : { thinking_levels: thinkingLevels }),
    input: capabilities,
    context_window: contextWindow,
    max_tokens: maxTokens,
    cost: { input: costInput, output: costOutput, cache_read: costCacheRead, cache_write: costCacheWrite },
  };
}

async function editModel(model: ModelConfig): Promise<ModelConfig | undefined> {
  const action = await select<ModelField>({
    message: `Edit model ${model.id}`,
    choices: [
      { value: 'name', name: `Name: ${model.name ?? model.id}` },
      { value: 'reasoning', name: `Reasoning: ${model.reasoning}` },
      { value: 'input', name: `Input: ${model.input.join(', ')}` },
      { value: 'context_window', name: `Context window: ${model.context_window}` },
      { value: 'max_tokens', name: `Max output tokens: ${model.max_tokens}` },
      { value: 'cost', name: 'Cost' },
      { value: 'cancel', name: 'Cancel' },
    ],
  });
  switch (action) {
    case 'name': {
      const name = await promptString('Display name', model.name ?? model.id);
      return { ...model, name };
    }
    case 'reasoning': {
      const reasoning = await confirm({ message: 'Supports reasoning', default: model.reasoning });
      if (reasoning) {
        return { ...model, reasoning };
      }
      // Only a reasoning model may declare thinking levels.
      const { thinking_levels: _dropped, ...rest } = model;
      return { ...rest, reasoning };
    }
    case 'input': {
      const capabilities = await promptInputCapabilities(model.input);
      return { ...model, input: capabilities };
    }
    case 'context_window': {
      const contextWindow = await promptPositiveInteger('Context window', model.context_window);
      return { ...model, context_window: contextWindow };
    }
    case 'max_tokens': {
      const maxTokens = await promptPositiveInteger('Max output tokens', model.max_tokens);
      if (maxTokens > model.context_window) {
        console.error('Max output tokens cannot exceed context window');
        return model;
      }
      return { ...model, max_tokens: maxTokens };
    }
    case 'cost': {
      const inputCost = await promptNonNegativeNumber('Input cost', model.cost.input);
      const outputCost = await promptNonNegativeNumber('Output cost', model.cost.output);
      const cacheRead = await promptNonNegativeNumber('Cache read cost', model.cost.cache_read);
      const cacheWrite = await promptNonNegativeNumber('Cache write cost', model.cost.cache_write);
      return {
        ...model,
        cost: { input: inputCost, output: outputCost, cache_read: cacheRead, cache_write: cacheWrite },
      };
    }
    default:
      return undefined;
  }
}

async function lookupModelDefaults(id: string): Promise<
  | {
      name: string;
      reasoning: boolean;
      input: Array<'text' | 'image'>;
      context_window: number;
      max_tokens: number;
      cost: { input: number; output: number; cache_read: number; cache_write: number };
      thinking_levels: ThinkingLevelConfig[] | null;
    }
  | undefined
> {
  let catalog: ModelsDevCatalog;
  try {
    catalog = await fetchModelsDevCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch models.dev catalog: ${message}`);
    return undefined;
  }
  const providers = listModelsDevProviders(catalog);
  const providerId = await searchChoice(
    'models.dev provider',
    providers.map((provider) => ({ value: provider.id, name: `${provider.name} (${provider.id})` })),
  );
  const provider = providers.find((p) => p.id === providerId);
  if (provider === undefined) {
    return undefined;
  }
  const exact = findModel(catalog, providerId, id);
  let model: ModelsDevModel | undefined = exact;
  if (model === undefined) {
    const models = listModelsDevModels(provider);
    const modelId = await searchChoice(
      `Select model ("${id}" not found in ${provider.name})`,
      models.map((candidate) => ({ value: candidate.id, name: `${candidate.name} (${candidate.id})` })),
    );
    model = findModel(catalog, providerId, modelId);
  }
  if (model === undefined) {
    return undefined;
  }
  const defaults = toModelDefaults(model);
  console.log(`Filled from models.dev: ${model.name}`);
  return defaults;
}

export async function discoverProviderModels(
  config: {
    readonly builtinProvider?: string;
    readonly baseUrl: string;
    readonly api: ApiAdapter;
    readonly apiKey: SecretRef;
    readonly headers?: Readonly<Record<string, SecretRef>>;
  },
  keyJar: string,
): Promise<DiscoveredProviderModel[]> {
  const secrets = new SecretStore(keyJar);
  try {
    // The wizard may use `jar`, `env` and `command` refs, so it resolves them here; the
    // listing call itself only ever sees the resolved values.
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(config.headers ?? {})) {
      headers[name] = await secrets.resolve(reference);
    }
    const listing = await fetchProviderModels({
      ...(config.builtinProvider === undefined ? {} : { builtinProvider: config.builtinProvider }),
      baseUrl: config.baseUrl,
      api: config.api,
      apiKey: await secrets.resolve(config.apiKey),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });
    console.log(
      `Fetched ${listing.models.length} model${listing.models.length === 1 ? '' : 's'} from ${listing.endpoint}`,
    );
    return [...listing.models];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch provider models: ${secrets.redact(message)}`);
    return [];
  }
}

export function validateBaseUrl(value: string): true | string {
  try {
    assertBaseUrl(value);
    return true;
  } catch {
    return 'Must be an HTTP(S) URL without credentials, query, or fragment';
  }
}

export async function searchChoice<Value>(message: string, choices: readonly SearchChoice<Value>[]): Promise<Value> {
  return search<Value>({
    message,
    source: (term) => filterSearchChoices(choices, term),
    pageSize: 15,
  });
}
