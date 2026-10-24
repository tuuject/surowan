import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../src/platform/load-env.ts';

const directories: string[] = [];
const envKeys: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
  for (const key of envKeys.splice(0)) {
    delete process.env[key];
  }
});

async function workingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-env-'));
  directories.push(directory);
  process.chdir(directory);
  return directory;
}

describe('environment file loading', () => {
  test('is a no-op when no env files exist', async () => {
    await workingDirectory();
    expect(() => loadEnvFiles(['.env.local', '.env'])).not.toThrow();
  });

  test('loads variables from .env.local and .env', async () => {
    const directory = await workingDirectory();
    envKeys.push('SUROWAN_TEST_ENV_LOCAL', 'SUROWAN_TEST_ENV_FILE');
    await writeFile(join(directory, '.env.local'), 'SUROWAN_TEST_ENV_LOCAL=from-local\n');
    await writeFile(join(directory, '.env'), 'SUROWAN_TEST_ENV_FILE=from-file\n');
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.SUROWAN_TEST_ENV_LOCAL).toBe('from-local');
    expect(process.env.SUROWAN_TEST_ENV_FILE).toBe('from-file');
  });

  test('keeps the real environment and .env.local ahead of .env', async () => {
    const directory = await workingDirectory();
    process.env.SUROWAN_TEST_ENV_PRECEDENCE = 'from-process';
    envKeys.push('SUROWAN_TEST_ENV_PRECEDENCE', 'SUROWAN_TEST_ENV_LOCALITY');
    await writeFile(
      join(directory, '.env.local'),
      'SUROWAN_TEST_ENV_PRECEDENCE=from-local\nSUROWAN_TEST_ENV_LOCALITY=from-local\n',
    );
    await writeFile(
      join(directory, '.env'),
      'SUROWAN_TEST_ENV_PRECEDENCE=from-file\nSUROWAN_TEST_ENV_LOCALITY=from-file\n',
    );
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.SUROWAN_TEST_ENV_PRECEDENCE).toBe('from-process');
    expect(process.env.SUROWAN_TEST_ENV_LOCALITY).toBe('from-local');
  });

  test('tolerates a UTF-8 BOM on the first line', async () => {
    const directory = await workingDirectory();
    envKeys.push('SUROWAN_TEST_ENV_BOM');
    // PowerShell 5 and legacy Notepad write this BOM; without stripping it the
    // first key silently becomes "\uFEFFKEY" and the variable stays unset.
    await writeFile(join(directory, '.env.local'), '\uFEFFSUROWAN_TEST_ENV_BOM=yes\n');
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.SUROWAN_TEST_ENV_BOM).toBe('yes');
  });
});
