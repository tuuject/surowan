import { expect, test } from 'vitest';
import { chmod, lstat, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { resolveAgentSettings } from '../src/platform/config-resolve.ts';
import {
  CHAT_ID,
  ADMIN,
  AGENT_MODEL,
  SECOND_MODEL,
  textUpdate,
  customProvider,
  model,
  fauxAgent,
  setup,
  runDirect,
} from './config-reload-fixtures.ts';

test('/model writes the file, keeps its comments and applies from the next run', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    const runtime = fixture.runtimeWith(faux);
    const jsonc = await fixture.readText();
    await fixture.writeText(`// Keep this comment.\n${jsonc}`);

    const options = fixture.modelSwitcher.list();
    const index = options.findIndex((option) => option.provider === 'faux' && option.model === SECOND_MODEL) + 1;
    expect(index).toBeGreaterThan(0);
    const reply = await fixture.commands.run({ name: 'model', argument: String(index) }, BigInt(CHAT_ID), ADMIN);
    expect(reply).toContain(`faux / ${SECOND_MODEL}`);
    expect(reply).toContain('本群');
    // Thinking level reset is handled internally by setChatModel; visible via /status.

    const text = await fixture.readText();
    expect(text).toContain('// Keep this comment.');
    expect(text).toContain(`"${SECOND_MODEL}"`);
    if (process.platform !== 'win32') {
      const { mode } = await stat(fixture.configPath);
      expect(mode & 0o777).toBe(0o600);
    }
    // A restart sees the same model: the file is the desired configuration.
    const reloaded = await loadConfig(fixture.configPath);
    expect(reloaded.config.agent!.model).toBe(AGENT_MODEL);
    expect(fixture.configStore.current().config.agent!.model).toBe(AGENT_MODEL);
    expect(resolveAgentSettings(reloaded.config, reloaded.config.telegram.chats[0])).toMatchObject({
      provider: 'faux',
      model: SECOND_MODEL,
      thinking_level: 'off',
    });
    expect(fixture.configStore.current().config.telegram.chats[0]?.model).toBe(SECOND_MODEL);

    faux.setResponses([() => fauxAssistantMessage('answer')]);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, invocationId);
    expect(
      fixture.store.db
        .prepare<[bigint], { model: string }>('SELECT model FROM model_calls WHERE invocation_id = ?')
        .all(invocationId)
        .map((row) => row.model),
    ).toEqual([SECOND_MODEL]);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a write failure without touching the file or the active configuration', async () => {
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 301;
    });
    const broken = await fixture.readText();
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('切换失败: ')).toBe(true);
    expect(await fixture.readText()).toBe(broken);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a config symlink instead of replacing it', async () => {
  const fixture = await setup();
  try {
    const linkPath = join(fixture.directory, 'link.jsonc');
    try {
      await symlink(fixture.configPath, linkPath);
    } catch {
      // Windows without Developer Mode refuses to create symlinks; the check
      // below covers the same code path on every other platform.
      return;
    }
    const linkLoader = new ConfigReloader({
      loaded: { ...fixture.loaded, configPath: linkPath },
      store: fixture.configStore,
      modelSwitcher: fixture.modelSwitcher,
      secrets: new SecretStore(),
      validateAgentModel: () => undefined,
      onPublished: () => undefined,
    });
    const result = await linkLoader.setAgentModel('agent', 'agent-model');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the symlinked config to be rejected');
    }
    expect(result.code).toBe('config_symlink');
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a read-only configuration directory', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const fixture = await setup();
  const before = fixture.configStore.current();
  const original = await fixture.readText();
  try {
    await chmod(fixture.directory, 0o500);
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('切换失败: ')).toBe(true);
    await chmod(fixture.directory, 0o700);
    expect(await fixture.readText()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    await chmod(fixture.directory, 0o700).catch(() => undefined);
    fixture.store.close();
  }
});

test('/model reports a written file that could not be applied', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 30;
      config.agent!.context!.idle_grace_seconds = 30;
    },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent!.context!.idle_grace_seconds = 10;
    });
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('已写入 config.jsonc，但应用失败: ')).toBe(true);
    // The write happened, the application did not.
    const written = await loadConfig(fixture.configPath);
    expect(written.config.telegram.chats[0]?.provider).toBe('agent');
    expect(written.config.agent!.provider).toBe('faux');
    expect(fixture.configStore.current().config.telegram.chats[0]?.provider).toBeUndefined();
    expect(fixture.configStore.current().config.agent!.provider).toBe('faux');
  } finally {
    fixture.store.close();
  }
});

test('setAgentModel resets the thinking level to the weakest one the new model accepts', async () => {
  const fixture = await setup({
    transform: (config) => {
      // `low` is valid on the current model but does not exist on the target.
      customProvider(config.providers, 'agent').models.push(
        model('agent-extra', { reasoning: true, thinking_levels: ['max', 'high'] }),
      );
    },
  });
  try {
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('low');
    const result = await fixture.reloader.setAgentModel('agent', 'agent-extra');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.model', 'agent.provider', 'agent.thinking_level']);
    expect(fixture.configStore.current().config.agent).toMatchObject({
      provider: 'agent',
      model: 'agent-extra',
      thinking_level: 'high',
    });
    expect(await fixture.readText()).toContain('"thinking_level": "high"');

    // Switching back does not restore the old level: it resets again.
    const back = await fixture.reloader.setAgentModel('faux', AGENT_MODEL);
    expect(back.ok).toBe(true);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('off');
  } finally {
    fixture.store.close();
  }
});

test('setAgentModel refuses a stale revision before writing', async () => {
  const fixture = await setup({
    transform: (config) => {
      customProvider(config.providers, 'agent').models.push(model('agent-extra'));
    },
  });
  try {
    const before = await fixture.readText();
    const result = await fixture.reloader.setAgentModel('agent', 'agent-extra', 'f'.repeat(64));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the stale revision to be refused');
    }
    expect(result.code).toBe('config_conflict');
    expect(result.fileWritten).toBe(false);
    expect(await fixture.readText()).toBe(before);
  } finally {
    fixture.store.close();
  }
});
