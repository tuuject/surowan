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

  test('reads the usual .env forms from a CRLF file and keeps an empty real variable', async () => {
    const directory = await workingDirectory();
    const keys = ['EXPORTED', 'QUOTED', 'SINGLE', 'COMMENTED', 'EMPTY', 'MULTILINE', 'COLON', 'PRESET'].map(
      (name) => `SUROWAN_TEST_ENV_${name}`,
    );
    envKeys.push(...keys);
    // An empty string is still "set": the file must not replace it.
    process.env.SUROWAN_TEST_ENV_PRESET = '';
    await writeFile(
      join(directory, '.env'),
      [
        '# a comment line',
        'export SUROWAN_TEST_ENV_EXPORTED=from export',
        'SUROWAN_TEST_ENV_QUOTED="two words"',
        "SUROWAN_TEST_ENV_SINGLE='keeps # hash'",
        'SUROWAN_TEST_ENV_COMMENTED=value # trailing comment',
        'SUROWAN_TEST_ENV_EMPTY=',
        'SUROWAN_TEST_ENV_MULTILINE="line one',
        'line two"',
        // Only `=` assigns; the YAML-like colon form is not an assignment.
        'SUROWAN_TEST_ENV_COLON: ignored',
        'SUROWAN_TEST_ENV_PRESET=from-file',
        '',
      ].join('\r\n'),
    );
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.SUROWAN_TEST_ENV_EXPORTED).toBe('from export');
    expect(process.env.SUROWAN_TEST_ENV_QUOTED).toBe('two words');
    expect(process.env.SUROWAN_TEST_ENV_SINGLE).toBe('keeps # hash');
    expect(process.env.SUROWAN_TEST_ENV_COMMENTED).toBe('value');
    expect(process.env.SUROWAN_TEST_ENV_EMPTY).toBe('');
    expect(process.env.SUROWAN_TEST_ENV_MULTILINE).toBe('line one\nline two');
    expect(process.env.SUROWAN_TEST_ENV_COLON).toBeUndefined();
    expect(process.env.SUROWAN_TEST_ENV_PRESET).toBe('');
  });
});
