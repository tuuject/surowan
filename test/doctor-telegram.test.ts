import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config/index.ts';
import { resolveDoctorTelegram } from '../src/doctor.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from './helpers.ts';

/**
 * The doctor has to tell three Telegram states apart: no token at all (a
 * working deployment without Telegram), a token that resolves (probe it), and a
 * token whose SecretRef cannot be read (a configuration error). The network
 * probe itself is `getMe` and is left to the manual acceptance matrix.
 */

const directories: string[] = [];
const ENV_NAME = 'SUROWAN_TEST_DOCTOR_TOKEN';

afterEach(async () => {
  delete process.env[ENV_NAME];
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(transform?: (config: FixtureConfig) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-doctor-telegram-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, transform);
  await writeTestConfig(directory, configPath, jsonc);
  return loadConfig(configPath);
}

test('a configuration without a telegram section reports Telegram disabled', async () => {
  const loaded = await fixture((config) => {
    const json = config as Record<string, unknown>;
    delete json.telegram;
  });
  expect(loaded.config.telegram.token).toBeUndefined();
  await expect(resolveDoctorTelegram(loaded.config, new SecretStore())).resolves.toEqual({ kind: 'disabled' });
});

test('a telegram section without a token reports Telegram disabled', async () => {
  const loaded = await fixture((config) => {
    const telegram = config.telegram as Record<string, unknown>;
    delete telegram.token;
  });
  expect(loaded.config.telegram.token).toBeUndefined();
  await expect(resolveDoctorTelegram(loaded.config, new SecretStore())).resolves.toEqual({ kind: 'disabled' });
});

test('a resolvable token is handed to the getMe probe', async () => {
  process.env[ENV_NAME] = '123456:doctor-fixture-token';
  const loaded = await fixture((config) => {
    config.telegram = { ...config.telegram, token: { env: ENV_NAME } };
  });
  await expect(resolveDoctorTelegram(loaded.config, new SecretStore())).resolves.toEqual({
    kind: 'token',
    token: '123456:doctor-fixture-token',
  });
});

test('an unreadable token is a configuration error, not a disabled Telegram', async () => {
  const loaded = await fixture((config) => {
    config.telegram = { ...config.telegram, token: { env: ENV_NAME } };
  });
  await expect(resolveDoctorTelegram(loaded.config, new SecretStore())).rejects.toThrow(
    `Telegram token cannot be read: Secret environment variable is not set: ${ENV_NAME}`,
  );
});

test('an empty resolved token is a disabled Telegram, like no token at all', async () => {
  process.env[ENV_NAME] = '';
  const loaded = await fixture((config) => {
    config.telegram = { ...config.telegram, token: { env: ENV_NAME } };
  });
  await expect(resolveDoctorTelegram(loaded.config, new SecretStore())).resolves.toEqual({ kind: 'disabled' });
});
