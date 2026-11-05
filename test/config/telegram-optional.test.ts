import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { TELEGRAM_DEFAULTS } from '../../src/platform/config/resolve.ts';
import { validateFileConfig } from '../../src/platform/config/validate.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';

/**
 * `telegram` is an optional section: a deployment that only wants the
 * playground writes none, and the runtime still sees a concrete section with no
 * Chats and no token. `admin` moved the other way and is now mandatory, with
 * `enabled` defaulting to true.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(transform?: (json: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-telegram-optional-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const parsed = JSON.parse(
    testConfigJsonc(directory, (config) => {
      const json = config as unknown as Record<string, unknown>;
      transform?.(json);
    }),
  ) as Record<string, unknown>;
  await writeTestConfig(directory, configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { directory, configPath, parsed };
}

function withoutTelegram(json: Record<string, unknown>): void {
  delete json.telegram;
}

test('a configuration without a telegram section loads with an empty runtime section', async () => {
  const { configPath } = await fixture(withoutTelegram);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.telegram).toBeUndefined();
  expect(loaded.config.telegram).toEqual({ ...TELEGRAM_DEFAULTS, chats: [] });
  expect(loaded.config.telegram.token).toBeUndefined();
  expect(loaded.warnings).toEqual([]);
});

test('admin is required, and an absent enabled means enabled', async () => {
  const missing = await fixture((json) => {
    delete json.admin;
  });
  expect(() => validateFileConfig(missing.parsed)).toThrow(/Invalid config/);

  const implicit = await fixture((json) => {
    json.admin = { host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
  });
  const loaded = await loadConfig(implicit.configPath);
  expect(loaded.config.admin.enabled).toBe(true);

  const disabled = await fixture((json) => {
    json.admin = { enabled: false, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
  });
  expect((await loadConfig(disabled.configPath)).config.admin.enabled).toBe(false);
});

test('rotating the token SecretRef is one hot change of the whole token', async () => {
  const active = await fixture();
  const activeLoaded = await loadConfig(active.configPath);
  const rotated = await fixture((json) => {
    (json.telegram as Record<string, unknown>).token = { jar: 'rotated-telegram' };
  });
  const rotatedLoaded = await loadConfig(rotated.configPath);
  const diff = diffConfig(
    { file: activeLoaded.fileConfig, raw: activeLoaded.config },
    { file: rotatedLoaded.fileConfig, raw: rotatedLoaded.config },
  );
  // A SecretRef is atomic: the change must not surface as a restart-only
  // `telegram.token.jar`, which would leave the running bot on the old token.
  expect(diff.changes).toContainEqual({ path: 'telegram.token', kind: 'hot' });
  expect(diff.changes.some((change) => change.path.startsWith('telegram.token.'))).toBe(false);
  expect(diff.candidate.file.telegram?.token).toEqual({ jar: 'rotated-telegram' });
  expect(diff.candidate.raw.telegram.token).toEqual({ jar: 'rotated-telegram' });
});
