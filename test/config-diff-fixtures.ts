import { afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileConfig } from '../src/platform/config.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { ConfigChange } from '../src/platform/config-diff.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export async function createDirectory(prefix = 'surowan-diff-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export interface DiffLoadResult {
  active: LoadedConfig;
  file: LoadedConfig;
  activeJsonc: (next: (config: FileConfig) => void) => string;
  directory: string;
  configPath: string;
}

export async function loadBoth(
  transform?: (config: FileConfig) => void,
  fileTransform?: (config: FileConfig) => void,
): Promise<DiffLoadResult> {
  const directory = await createDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const active = await loadConfig(configPath);
  const fileJsonc = testConfigJsonc(directory, (config) => {
    transform?.(config);
    fileTransform?.(config);
  });
  await writeTestConfig(directory, configPath, fileJsonc);
  const file = await loadConfig(configPath);
  return {
    active,
    file,
    directory,
    configPath,
    activeJsonc: (next) =>
      testConfigJsonc(directory, (config) => {
        transform?.(config);
        next(config);
      }),
  };
}

export function paths(changes: readonly ConfigChange[], kind: ConfigChange['kind']): string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

export type ProviderEntry = FileConfig['providers'][string];
export type ModelEntry = Extract<ProviderEntry, { kind: 'custom' }>['models'][number];

export function spareModel(): ModelEntry {
  return {
    id: 'spare',
    reasoning: false,
    input: ['text'],
    context_window: 64_000,
    max_tokens: 4_096,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  };
}

export function customModels(config: FileConfig, alias: string): readonly ModelEntry[] {
  const provider = config.providers[alias];
  if (provider === undefined || provider.kind !== 'custom') {
    throw new Error(`Expected a custom provider fixture: ${alias}`);
  }
  return provider.models;
}
