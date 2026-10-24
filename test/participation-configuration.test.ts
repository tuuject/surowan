import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from './helpers.ts';
import { cleanupDirectories, directories, setup } from './participation-fixtures.ts';

afterEach(async () => {
  await cleanupDirectories();
});

describe('participation configuration', () => {
  async function configError(transform: (config: FixtureConfig) => void): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-participation-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
    try {
      await loadConfig(configPath);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected loadConfig to reject the configuration');
  }

  test('rejects a zero-length active window', async () => {
    const message = await configError((config) => {
      config.telegram.participation = { active_windows: [{ start: '09:00', end: '09:00' }] };
    });
    expect(message).toContain('empty active window');
  });

  test('rejects participation on a private chat', async () => {
    const message = await configError((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected the default chat');
      }
      chat.participation = { trigger_keywords: ['塑料碗'] };
    });
    expect(message).toContain('private chat');
  });

  test('rejects malformed clock times, weekdays, and empty keywords', async () => {
    expect(
      await configError((config) => {
        config.telegram.participation = { active_windows: [{ start: '9:00', end: '12:00' }] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { active_windows: [{ start: '09:00', end: '12:00', days: [0] }] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { trigger_keywords: [''] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { attention_window_seconds: 0 };
      }),
    ).toContain('Invalid config');
  });

  test('accepts empty window and keyword lists', async () => {
    const harness = await setup({ global: { active_windows: [], trigger_keywords: [] } });
    expect(harness.config.telegram.participation?.active_windows).toEqual([]);
    harness.store.close();
  });
});
