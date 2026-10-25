import type { FileConfig } from './config.ts';
import type { ConfigSource } from './config-diff.ts';
import { type ChangeRecorder, deepEqual, mergeField, unionKeys } from './config-diff-merge.ts';

/**
 * Provider and per-model merge: adding, removing or re-kinding a provider is
 * hot because a reload rebuilds the registry and publishes it with the
 * configuration; the model list follows the file's order.
 */

type ProviderFileConfig = FileConfig['providers'][string];
type CustomProviderFileConfig = Extract<ProviderFileConfig, { kind: 'custom' }>;
type ModelFileConfig = CustomProviderFileConfig['models'][number];

export function mergeProviders(
  active: ConfigSource,
  file: ConfigSource,
  recorder: ChangeRecorder,
): FileConfig['providers'] {
  const result: Record<string, ProviderFileConfig> = {};
  for (const [alias, activeProvider] of Object.entries(active.file.providers)) {
    const fileProvider = file.file.providers[alias];
    if (fileProvider === undefined || fileProvider.kind !== activeProvider.kind) {
      // Adding, removing or re-kinding a provider is hot: the reload rebuilds the
      // registry and publishes it with the configuration.
      recorder.add(`providers.${alias}`, 'hot');
      if (fileProvider !== undefined) {
        result[alias] = structuredClone(fileProvider);
      }
      continue;
    }
    const activeRecord = activeProvider as unknown as Record<string, unknown>;
    const fileRecord = fileProvider as unknown as Record<string, unknown>;
    const merged = structuredClone(activeProvider) as unknown as Record<string, unknown>;
    for (const key of unionKeys(activeRecord, fileRecord)) {
      if (key === 'models') {
        continue;
      }
      mergeField(activeRecord, fileRecord, merged, key, `providers.${alias}.${key}`, recorder);
    }
    // Both kinds carry `models`: for a builtin provider the list is the enabled
    // subset of Pi's catalog, and changing it is as hot as it is for custom.
    merged.models = mergeModels(alias, activeProvider.models, fileProvider.models, recorder);
    result[alias] = merged as unknown as ProviderFileConfig;
  }
  for (const [alias, fileProvider] of Object.entries(file.file.providers)) {
    if (!Object.hasOwn(active.file.providers, alias)) {
      recorder.add(`providers.${alias}`, 'hot');
      result[alias] = structuredClone(fileProvider);
    }
  }
  return result;
}

function mergeModels(
  alias: string,
  activeModels: readonly ModelFileConfig[],
  fileModels: readonly ModelFileConfig[],
  recorder: ChangeRecorder,
): ModelFileConfig[] {
  const activeById = new Map(activeModels.map((model) => [model.id, model]));
  const result: ModelFileConfig[] = [];
  // The file order wins: it is the order the provider is rebuilt in.
  for (const model of fileModels) {
    const path = `providers.${alias}.models[${model.id}]`;
    const activeModel = activeById.get(model.id);
    if (activeModel === undefined || !deepEqual(activeModel, model)) {
      recorder.add(path, 'hot');
    }
    result.push(structuredClone(model));
  }
  for (const model of activeModels) {
    if (!fileModels.some((candidate) => candidate.id === model.id)) {
      recorder.add(`providers.${alias}.models[${model.id}]`, 'hot');
    }
  }
  return result;
}
