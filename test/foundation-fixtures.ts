import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

export async function cleanupFixtureDirectories(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}
