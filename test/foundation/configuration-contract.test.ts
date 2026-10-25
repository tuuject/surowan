import { afterEach, describe, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { testConfigJsonc } from '../helpers.ts';
import { cleanupFixtureDirectories, fixture } from './fixtures.ts';

afterEach(cleanupFixtureDirectories);

describe('configuration', () => {
  test('rejects unknown fields', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config, { unknown: true })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects the removed per-invocation limits', async () => {
    const { directory, configPath } = await fixture();
    for (const key of ['max_turns', 'max_sends', 'timeout_seconds'] as const) {
      await writeFile(
        configPath,
        testConfigJsonc(directory, (config) => Object.assign(config.agent, { [key]: 5 })),
      );
      // The error has to name the offending key, otherwise the operator is left diffing by hand.
      await expect(loadConfig(configPath)).rejects.toThrow(key);
    }
  });

  test('allow_reply_message_multiple_times is optional and boolean-only', async () => {
    const { directory, configPath } = await fixture();
    // Omitted: accepted, and the resolved configuration keeps it absent — no
    // default mechanism turns it into an explicit false.
    const omitted = await loadConfig(configPath);
    expect(omitted.config.agent!.allow_reply_message_multiple_times).toBeUndefined();
    expect(omitted.fileConfig.agent!.allow_reply_message_multiple_times).toBeUndefined();
    // Both explicit values are accepted and preserved.
    for (const value of [false, true]) {
      await writeFile(
        configPath,
        testConfigJsonc(directory, (config) => {
          config.agent!.allow_reply_message_multiple_times = value;
        }),
      );
      const loaded = await loadConfig(configPath);
      expect(loaded.config.agent!.allow_reply_message_multiple_times).toBe(value);
      expect(loaded.fileConfig.agent!.allow_reply_message_multiple_times).toBe(value);
    }
    // Anything that is not a boolean is rejected by the schema.
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        Object.assign(config.agent, { allow_reply_message_multiple_times: 'yes' });
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('enforces the Conversation Context invariants', async () => {
    const { directory, configPath } = await fixture();
    const reload = async (transform: Parameters<typeof testConfigJsonc>[1]): Promise<unknown> => {
      await writeFile(configPath, testConfigJsonc(directory, transform));
      return loadConfig(configPath);
    };
    // A target that is not below the trigger threshold can never converge.
    await expect(
      reload((config) => {
        config.agent!.context!.retained_sends_target = config.agent!.context!.retained_sends_max;
      }),
    ).rejects.toThrow('retained_sends_target must be smaller');
    // GC has to run before the closing mode takes over.
    await expect(
      reload((config) => {
        config.agent!.context!.hard_token_ratio = 0.9;
      }),
    ).rejects.toThrow('hard_token_ratio');
    // A grace shorter than one bucket window would look enabled while every run
    // ends before the next bucket is due.
    await expect(
      reload((config) => {
        config.telegram.bucket_window_seconds = 15;
        config.agent!.context!.idle_grace_seconds = 5;
      }),
    ).rejects.toThrow('idle_grace_seconds must be 0');
    // 0 is the supported way to turn long-lived invocations off.
    await expect(
      reload((config) => {
        config.agent!.context!.idle_grace_seconds = 0;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent!.context!.idle_grace_seconds = 15;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent!.context!.idle_grace_seconds = 15;
        config.agent!.context!.max_wall_clock_seconds = 15;
      }),
    ).rejects.toThrow('max_wall_clock_seconds must exceed');
  });

  test('accepts zero-second bucket windows and rejects values above three hundred seconds', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
      }),
    );
    expect((await loadConfig(configPath)).config.telegram.bucket_window_seconds).toBe(0);
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 301;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });
});
