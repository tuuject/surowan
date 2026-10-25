import { afterAll, describe, expect, test } from 'vitest';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import type { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';
import {
  ALICE,
  type ConfigTransform,
  FIXED_NOW,
  cleanupDirectories,
  setup,
  textUpdate,
} from './bot-commands-fixtures.ts';

afterAll(cleanupDirectories);

describe('bot command service', () => {
  test('pause and resume are denied for non-admins without side effects', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    const mallory: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
    expect(await commands.run({ name: 'pause' }, 123456789n, mallory, FIXED_NOW)).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('queued');
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM invocations').get()?.state).toBe('queued');
    expect(await commands.run({ name: 'resume' }, 123456789n, mallory, FIXED_NOW)).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    store.close();
  });

  test('anonymous senders and absent admins are denied', async () => {
    const { store, commands } = await setup(() => {});
    expect(await commands.run({ name: 'pause' }, 123456789n, null, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
    const stranger: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
    expect(await commands.run({ name: 'pause' }, 123456789n, stranger, FIXED_NOW)).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(await commands.run({ name: 'status' }, 123456789n, stranger, FIXED_NOW)).toContain('本群模型');
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    store.close();
  });

  test('whoami replies with the sender id and is not admin gated', async () => {
    const { store, commands } = await setup();
    expect(await commands.run({ name: 'whoami' }, 123456789n, ALICE, FIXED_NOW)).toBe('42');
    const stranger: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
    expect(await commands.run({ name: 'whoami' }, 123456789n, stranger, FIXED_NOW)).toBe('99');
    expect(await commands.run({ name: 'whoami' }, 123456789n, null, FIXED_NOW)).toBe('无法识别发送者。');
    store.close();
  });

  describe('allowlist command', () => {
    async function allowlistSetup(transform?: ConfigTransform): Promise<{
      store: SqliteStore;
      commands: BotCommandService;
      configStore: RuntimeConfigurationStore;
      configPath: string;
      directory: string;
    }> {
      const { store, loaded, scheduler, configStore, configPath, directory } = await setup(transform);
      const switcher = new AgentModelSwitcher(configStore);
      const reloader = new ConfigReloader({
        loaded,
        store: configStore,
        modelSwitcher: switcher,
        secrets: new SecretStore(),
        validateAgentModel: () => undefined,
        onPublished: () => undefined,
      });
      const commands = new BotCommandService(store, configStore, scheduler, switcher, undefined, reloader);
      return { store, commands, configStore, configPath, directory };
    }

    test('is denied for non-admins without touching the configuration', async () => {
      const { store, commands, configStore, configPath } = await allowlistSetup();
      const before = configStore.current();
      const stranger: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
      expect(await commands.run({ name: 'allowlist' }, 987654321n, stranger, FIXED_NOW)).toBe(
        '该命令仅对本 Bot 的管理员可用。',
      );
      expect(configStore.current()).toBe(before);
      expect(await loadConfig(configPath).then((loaded) => loaded.fileConfig.telegram?.chats)).toHaveLength(1);
      store.close();
    });

    test('replies that a configured chat is already allowlisted', async () => {
      const { store, commands, configStore } = await allowlistSetup();
      const before = configStore.current();
      expect(await commands.run({ name: 'allowlist' }, 123456789n, ALICE, FIXED_NOW)).toBe('本群已在白名单中。');
      expect(configStore.current()).toBe(before);
      store.close();
    });

    test('reports an unavailable runtime without a reloader', async () => {
      const { store, scheduler, configStore } = await setup();
      const commands = new BotCommandService(store, configStore, scheduler);
      expect(await commands.run({ name: 'allowlist' }, 987654321n, ALICE, FIXED_NOW)).toBe('运行时配置应用不可用。');
      store.close();
    });

    test('appends the chat to the file, hot-applies it and reports success', async () => {
      const { store, commands, configStore, configPath } = await allowlistSetup();
      expect(await commands.run({ name: 'allowlist' }, 987654321n, ALICE, FIXED_NOW)).toBe(
        '已将本群加入白名单，配置已立即生效。',
      );
      expect(await loadConfig(configPath).then((loaded) => loaded.fileConfig.telegram?.chats.at(-1))).toEqual({
        id: 987654321,
      });
      expect(configStore.current().config.telegram.chats.at(-1)?.id).toBe(987654321);
      expect(configStore.current().generation).toBe(2);
      store.close();
    });

    test('reports a rejected add and leaves the file untouched', async () => {
      const { store, commands, configStore, configPath, directory } = await allowlistSetup();
      // A duplicate chat ID makes the file unloadable, so the add is refused
      // before anything is written.
      await writeTestConfig(
        directory,
        configPath,
        testConfigJsonc(directory, (config) => {
          config.telegram.admins = [42];
          config.telegram.chats.push({ id: 123456789 });
        }),
      );
      const before = configStore.current();
      const reply = await commands.run({ name: 'allowlist' }, 987654321n, ALICE, FIXED_NOW);
      expect(reply).toContain('加入白名单失败');
      expect(configStore.current()).toBe(before);
      store.close();
    });
  });
});
