import { afterEach, describe, expect, test } from 'vitest';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { writeConfigEdits } from '../../src/adapters/local-monolith/config/file.ts';
import { secretEdit } from '../../src/platform/config/write.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { buildModelRegistry, requireModel } from '../../src/platform/providers.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { backupDatabase, SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { schemaMigrations } from '../../src/store/schema/index.ts';
import { pathExists, testConfigJsonc, writeTestKeyJar } from '../helpers.ts';
import { cleanupFixtureDirectories, fixture } from './fixtures.ts';

afterEach(cleanupFixtureDirectories);

describe('configuration', () => {
  test('accepts the complete version 1 contract', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent!.context!.idle_grace_seconds).toBe(0);
    expect(loaded.config.agent!.rate_limits!.sends_per_window).toBe(6);
    expect(loaded.config.telegram.bucket_window_seconds).toBe(15);
    const agentProvider = loaded.config.providers.agent;
    expect(agentProvider?.kind).toBe('custom');
    if (agentProvider?.kind !== 'custom') {
      throw new Error('Expected the custom agent provider');
    }
    expect(agentProvider.models[0]?.compat?.supports_developer_role).toBe(false);
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
    expect(requireModel(registry.models, 'agent', 'agent-model', ['text']).compat).toMatchObject({
      supportsDeveloperRole: false,
    });
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('key jar', () => {
  test('names every plaintext secret instead of failing a union', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        (config.telegram as { token: unknown }).token = 'telegram-literal';
        const agent = config.providers.agent;
        if (agent?.kind === 'custom') {
          (agent as { headers: unknown }).headers = { 'x-route': 'header-literal', 'x-env': { env: 'ROUTE' } };
        }
      }),
    );
    const message = await loadConfig(configPath).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );
    expect(message).toContain('plaintext secrets are not accepted');
    expect(message).toContain('telegram.token, providers.agent.headers.x-route');
    expect(message).not.toContain('x-env');
    expect(message).not.toContain('literal');
  });

  test('stores secret edits in the jar and drops the entries the file stops using', async () => {
    const { configPath } = await fixture();
    const jar = keyJarPath(configPath);
    await writeConfigEdits(configPath, [secretEdit(['providers', 'agent', 'api_key'], 'agent-rotated-key')]);
    const text = await readFile(configPath, 'utf8');
    expect(text).not.toContain('agent-rotated-key');
    const { fileConfig } = await loadConfig(configPath);
    const reference = fileConfig.providers.agent?.api_key as { jar: string };
    expect(reference.jar).toMatch(/^[0-9a-f]{16}$/);
    const stored = JSON.parse(await readFile(jar, 'utf8')) as Record<string, string>;
    // The replaced `agent` entry is gone; the untouched ones stay.
    expect(stored).toEqual({
      telegram: 'telegram-secret',
      vision: 'vision-secret',
      [reference.jar]: 'agent-rotated-key',
    });
    expect(await new SecretStore(jar).resolve(reference)).toBe('agent-rotated-key');

    // A rejected edit leaves neither file changed.
    await expect(
      writeConfigEdits(configPath, [
        secretEdit(['providers', 'vision', 'api_key'], 'never-stored'),
        { path: ['agent', 'model'], value: 'absent-model' },
      ]),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(await readFile(configPath, 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(jar, 'utf8'))).toEqual(stored);
  });
});

describe('secrets', () => {
  test('removes one trailing newline and redacts exact values', async () => {
    const store = new SecretStore();
    const value = await store.resolve({ command: [process.execPath, '-e', "process.stdout.write('secret-value\\n')"] });
    expect(value).toBe('secret-value');
    expect(store.redact('failed secret-value request')).toBe('failed [REDACTED] request');
  });

  test('redacts a secret in full when another known secret is its prefix or overlaps it', () => {
    const store = new SecretStore();
    // Submission order used to decide the result: the shorter value replaced
    // first and left the longer one's tail in the clear.
    store.remember('abcdef-short');
    store.remember('abcdef-short-and-long');
    store.remember('xyz-overlap-1');
    store.remember('overlap-1-tail');
    expect(store.redact('key=abcdef-short-and-long;')).toBe('key=[REDACTED];');
    expect(store.redact('a abcdef-short b')).toBe('a [REDACTED] b');
    expect(store.redact('[xyz-overlap-1-tail]')).toBe('[[REDACTED]]');
    expect(store.redact('abcdef-short abcdef-short')).toBe('[REDACTED] [REDACTED]');
    expect(store.redact('nothing to hide')).toBe('nothing to hide');
  });

  test('keeps submitted plaintext redactable without letting it accumulate', async () => {
    const { directory, configPath } = await fixture();
    await writeTestKeyJar(directory, { configured: 'configured-api-key' });
    const store = new SecretStore(keyJarPath(configPath));
    const configured = await store.resolve({ jar: 'configured' });
    store.remember('submitted-api-key');
    expect(configured).toBe('configured-api-key');
    expect(store.redact('sent submitted-api-key upstream')).toBe('sent [REDACTED] upstream');
    // A session that keeps submitting keys must not grow the store forever, and
    // the configured secret is not what gets dropped.
    for (let index = 0; index < 200; index += 1) {
      store.remember(`throwaway-key-${String(index)}`);
    }
    expect(store.redact('sent submitted-api-key upstream')).toBe('sent submitted-api-key upstream');
    expect(store.redact('sent throwaway-key-199 upstream')).toBe('sent [REDACTED] upstream');
    expect(store.redact('sent configured-api-key upstream')).toBe('sent [REDACTED] upstream');
  });

  test('resolves key jar entries and redacts them', async () => {
    const { directory, configPath } = await fixture();
    await writeTestKeyJar(directory, { relay: 'relay-api-key' });
    const store = new SecretStore(keyJarPath(configPath));
    expect(await store.resolve({ jar: 'relay' })).toBe('relay-api-key');
    expect(store.redact('sent relay-api-key upstream')).toBe('sent [REDACTED] upstream');
    await expect(store.resolve({ jar: 'missing' })).rejects.toThrow('Key jar has no entry missing');
    // Inherited object members are not entries.
    await expect(store.resolve({ jar: 'constructor' })).rejects.toThrow('Key jar has no entry constructor');
    await expect(new SecretStore().resolve({ jar: 'relay' })).rejects.toThrow('No key jar is configured');
  });

  test('reports a broken key jar without quoting it', async () => {
    const { configPath } = await fixture();
    const jar = keyJarPath(configPath);
    const store = new SecretStore(jar);
    await unlink(jar);
    await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('Key jar does not exist');
    // A parse error would echo the text around the fault, which is a secret.
    await writeFile(jar, '{ "agent": "sk-leaky-value" ', { mode: 0o600 });
    const invalid = await store.resolve({ jar: 'agent' }).catch((error: unknown) => error as Error);
    expect(invalid).toMatchObject({ name: 'SecretResolutionError', message: `Key jar is not valid JSON: ${jar}` });
    await writeFile(jar, '{ "agent": 42 }');
    await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('JSON object of non-empty strings');
    if (process.platform !== 'win32') {
      await writeFile(jar, '{ "agent": "agent-secret" }');
      await chmod(jar, 0o644);
      await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('Key jar must have mode 0600');
    }
  });

  test('does not turn a very short value into a redaction pattern', () => {
    const store = new SecretStore();
    store.remember('1');
    expect(store.redact('providers.relay.models[0] failed with status 1')).toBe(
      'providers.relay.models[0] failed with status 1',
    );
  });
});

describe('database', () => {
  test('closing the store invalidates prepared ORM queries and releases the file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const prepared = store.orm.select().from(schemaMigrations).prepare();
      expect(prepared.all()).toHaveLength(47);
      store.close();
      expect(() => prepared.all()).toThrow();
      await unlink(config.paths.database);
      expect(await pathExists(config.paths.database)).toBe(false);
    } finally {
      store.db.close();
    }
  });

  test('applies migrations, creates a consistent backup, and releases the source file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const version = store.db
        .prepare<[], { version: bigint }>('SELECT MAX(version) AS version FROM schema_migrations')
        .get();
      expect(version?.version).toBe(47n);
    } finally {
      store.close();
    }

    const backupPath = await backupDatabase(config);
    expect(await pathExists(backupPath)).toBe(true);
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });

  test('a failed backup releases the source file after running ORM queries', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      store.db.exec('DROP TABLE telegram_updates');
    } finally {
      store.close();
    }

    await expect(backupDatabase(config)).rejects.toThrow('telegram_updates');
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });
});
