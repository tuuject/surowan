import { expect, test } from 'vitest';
import { fauxProvider } from '@earendil-works/pi-ai';
import { AGENT_MODEL, logEvents, builtinProvider, model, setup } from './config-reload-fixtures.ts';

test('applies a hot field and reports both hashes', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.thinking_level']);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual([]);
    expect(result.status.generation).toBe(2);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('high');
    const event = logEvents('config_reloaded').at(-1);
    expect(event).toMatchObject({
      generation: 2,
      applied: 'agent.thinking_level',
      restart_required: '',
      outside_serve: '',
    });
    expect(event?.active_hash).toBe(result.status.activeHash);
    expect(event?.file_hash).toBe(result.status.fileHash);
    // Nothing is pending, so the active configuration is exactly the file and
    // its hash stays comparable with `check-config` output.
    expect(result.status.activeHash).toBe(result.status.fileHash);
    expect(result.status.activeHash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    fixture.store.close();
  }
});

test('keeps the active configuration when the file is invalid', async () => {
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    const cases: readonly (readonly [string, () => Promise<void>])[] = [
      ['jsonc', () => fixture.writeText('{ "version": 1, ')],
      [
        'schema',
        () =>
          fixture.patch((config) => {
            config.telegram.bucket_window_seconds = 301;
          }),
      ],
      [
        'prompt',
        () =>
          fixture.patch((config) => {
            config.agent!.system_prompt_file = 'missing-prompt.md';
          }),
      ],
    ];
    for (const [label, write] of cases) {
      await write();
      const result = await fixture.reloader.reloadFromFile();
      expect(result.ok, label).toBe(false);
      if (result.ok) {
        throw new Error(`Expected ${label} to fail`);
      }
      expect(result.code, label).toBe('config_invalid');
      expect(fixture.configStore.current(), label).toBe(before);
      expect(fixture.reloader.status().lastError?.code, label).toBe('config_invalid');
    }
    expect(logEvents('config_reload_failed')).toHaveLength(3);
    expect(fixture.reloader.status().generation).toBe(1);
  } finally {
    fixture.store.close();
  }
});

test('refuses a candidate whose model cannot run the tool registry', async () => {
  const fixture = await setup();
  try {
    const faux = fauxProvider({
      provider: 'faux',
      models: [
        { id: AGENT_MODEL, input: ['text'], contextWindow: 200_000, maxTokens: 32_768 },
        { id: 'tiny-model', input: ['text'], contextWindow: 1_000, maxTokens: 512 },
      ],
    });
    fixture.runtimeWith(faux);
    await fixture.patch((config) => {
      builtinProvider(config.providers, 'faux').models.push(
        model('tiny-model', { reasoning: true, context_window: 1_000, max_tokens: 512 }),
      );
      config.agent!.model = 'tiny-model';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the tiny model to be refused');
    }
    expect(result.code).toBe('model_unusable');
    expect(result.message).toMatch(/10% of the model context window/);
    expect(fixture.configStore.current().config.agent!.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('refuses a builtin model the file does not list', async () => {
  const fixture = await setup();
  try {
    // A builtin provider's models come from the file, so an unregistered
    // reference is a file error: `check-config` rejects it before a reload does.
    await fixture.patch((config) => {
      config.agent!.model = 'no-such-model';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the unknown model to be refused');
    }
    expect(result.code).toBe('config_invalid');
    expect(result.message).toContain('no-such-model');
    expect(fixture.configStore.current().config.agent!.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('rejects a candidate that is only invalid together with a pending restart field', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 30;
      config.agent!.context!.idle_grace_seconds = 30;
    },
  });
  try {
    // Both values are valid in the file (10 >= 5), but the running process keeps
    // bucket_window_seconds = 30 until it restarts, so 10 < 30 is invalid here.
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent!.context!.idle_grace_seconds = 10;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the candidate to be rejected');
    }
    expect(result.code).toBe('candidate_invalid');
    expect(result.message).toContain('after a restart');
    expect(result.message).toContain('telegram.bucket_window_seconds');
    expect(fixture.configStore.current().config.telegram.bucket_window_seconds).toBe(30);
    expect(fixture.configStore.current().config.agent!.context!.idle_grace_seconds).toBe(30);
  } finally {
    fixture.store.close();
  }
});

test('a comment-only edit moves the active hash to the new file hash', async () => {
  const fixture = await setup();
  try {
    await fixture.writeText(`// operator note\n${await fixture.readText()}`);
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.status.fileHash).not.toBe(fixture.loaded.hash);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});

test('a model switch refused before writing leaves the apply status alone', async () => {
  const fixture = await setup();
  try {
    const result = await fixture.reloader.setAgentModel('agent', 'ghost-model');
    expect(result).toMatchObject({ ok: false, code: 'unknown_model', fileWritten: false });
    // No reload ran, so the status keeps describing the last apply.
    expect(fixture.reloader.status().lastError).toBeNull();
    expect(logEvents('model_switch_failed').at(-1)).toMatchObject({ code: 'unknown_model' });
    expect(logEvents('config_reload_failed')).toEqual([]);
  } finally {
    fixture.store.close();
  }
});
