import { afterAll, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { BotCommandService, type CommandSender } from '../../src/orchestration/bot-commands/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { chatMigrations } from '../../src/store/schema/index.ts';
import { ALICE, type ConfigTransform, cleanupDirectories, FIXED_NOW, setup } from './fixtures.ts';

afterAll(cleanupDirectories);

const CHAT_ID = 123456789n;
const DENIED = '该命令仅对本 Bot 的管理员可用。';
const SUPPORTED = 'off, minimal, low, medium, high';

describe('bot command service', () => {
  async function commandSetup(transform?: ConfigTransform): Promise<{
    store: SqliteStore;
    commands: BotCommandService;
    reloader: ConfigReloader;
    configStore: RuntimeConfigurationStore;
  }> {
    const { store, loaded, scheduler, configStore } = await setup(transform);
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
    return { store, commands, reloader, configStore };
  }

  describe('effort command', () => {
    test('is denied for non-admins without touching the configuration', async () => {
      const { store, commands, configStore } = await commandSetup();
      const before = configStore.current();
      const stranger: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
      expect(await commands.run({ name: 'effort' }, CHAT_ID, stranger, FIXED_NOW)).toBe(DENIED);
      expect(await commands.run({ name: 'effort', argument: 'high' }, CHAT_ID, stranger, FIXED_NOW)).toBe(DENIED);
      expect(await commands.run({ name: 'effort', argument: 'default' }, CHAT_ID, stranger, FIXED_NOW)).toBe(DENIED);
      expect(await commands.run({ name: 'effort' }, CHAT_ID, null, FIXED_NOW)).toBe(DENIED);
      expect(configStore.current()).toBe(before);
      store.close();
    });

    test('without an argument lists what the effective model accepts', async () => {
      const { store, commands } = await commandSetup();
      const reply = await commands.run({ name: 'effort' }, CHAT_ID, ALICE, FIXED_NOW);
      expect(reply.split('\n')).toEqual([
        '本群模型: agent / agent-model',
        '思考强度: low（继承全局）',
        `可选: ${SUPPORTED}`,
        '使用 /effort 级别 设置本群强度，/effort default 恢复继承全局',
      ]);
      store.close();
    });

    test('follows a Chat model override and reports a model without thinking levels', async () => {
      const { store, commands } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats = [{ id: 123456789, provider: 'vision', model: 'vision-model', thinking_level: 'off' }];
      });
      const reply = await commands.run({ name: 'effort' }, CHAT_ID, ALICE, FIXED_NOW);
      expect(reply).toContain('本群模型: vision / vision-model');
      expect(reply).toContain('思考强度: off\n');
      expect(reply).toContain('可选: off（该模型不支持思考）');
      expect(reply).toContain('使用 /effort default 恢复继承全局');
      store.close();
    });

    test('labels a reasoning model with a single declared level as configurable', async () => {
      const { store, commands } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.agent.thinking_level = 'high';
        const model = config.providers.agent?.models[0];
        if (model !== undefined) {
          model.thinking_levels = ['high'];
        }
      });
      const reply = await commands.run({ name: 'effort' }, CHAT_ID, ALICE, FIXED_NOW);
      expect(reply.split('\n')).toEqual([
        '本群模型: agent / agent-model',
        '思考强度: high（继承全局）',
        '可选: high',
        '使用 /effort 级别 设置本群强度，/effort default 恢复继承全局',
      ]);
      store.close();
    });

    test('/effort default clears an override while the Chat has no complete model', async () => {
      const { store, commands, reloader } = await commandSetup((config) => {
        config.telegram.admins = [42];
        delete (config.agent as { provider?: string }).provider;
        delete (config.agent as { model?: string }).model;
        config.telegram.chats = [{ id: 123456789, thinking_level: 'high' }];
      });
      try {
        expect(await commands.run({ name: 'effort' }, CHAT_ID, ALICE, FIXED_NOW)).toBe(
          '本群尚未配置模型，无法查看或设置思考强度。',
        );
        const reply = await commands.run({ name: 'effort', argument: 'default' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(reply).toBe('已清除本群思考强度覆盖，跟随全局 low，将在下一次 agent session 生效。');
        expect((await loadConfig(reloader.configPath)).fileConfig.telegram?.chats).toEqual([{ id: 123456789 }]);
      } finally {
        store.close();
      }
    });

    test('writes only the Chat thinking level, keeps other Chats and overrides, and status reflects it', async () => {
      const { store, commands, reloader } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats.push({ id: -1009876543210 });
      });
      try {
        const reply = await commands.run({ name: 'effort', argument: 'high' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(reply).toBe('已为本群设置思考强度: high，已写入 config.jsonc，将在下一次 agent session 生效。');
        const loaded = await loadConfig(reloader.configPath);
        const chat = loaded.fileConfig.telegram?.chats.find((entry) => entry.id === 123456789);
        expect(chat).toMatchObject({ thinking_level: 'high' });
        expect(chat).not.toHaveProperty('provider');
        expect(chat).not.toHaveProperty('model');
        expect(loaded.fileConfig.telegram?.chats.find((entry) => entry.id === -1009876543210)).not.toHaveProperty(
          'thinking_level',
        );
        expect((await commands.run({ name: 'status' }, CHAT_ID, ALICE, FIXED_NOW)).split('\n')[1]).toBe(
          '思考强度: high',
        );
      } finally {
        store.close();
      }
    });

    test('keeps a Chat model override while changing the level', async () => {
      const { store, commands, reloader } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats = [{ id: 123456789, provider: 'vision', model: 'vision-model', thinking_level: 'off' }];
      });
      try {
        expect(await commands.run({ name: 'effort', argument: 'off' }, CHAT_ID, ALICE, FIXED_NOW)).toContain(
          '已为本群设置思考强度: off',
        );
        const loaded = await loadConfig(reloader.configPath);
        expect(loaded.fileConfig.telegram?.chats).toEqual([
          { id: 123456789, provider: 'vision', model: 'vision-model', thinking_level: 'off' },
        ]);
      } finally {
        store.close();
      }
    });

    test('accepts a level regardless of case', async () => {
      const { store, commands, reloader } = await commandSetup();
      try {
        expect(await commands.run({ name: 'effort', argument: 'HIGH' }, CHAT_ID, ALICE, FIXED_NOW)).toContain(
          '已为本群设置思考强度: high',
        );
        expect((await loadConfig(reloader.configPath)).fileConfig.telegram?.chats[0]?.thinking_level).toBe('high');
      } finally {
        store.close();
      }
    });

    test('rejects unknown and unsupported levels without writing', async () => {
      const { store, commands, reloader, configStore } = await commandSetup();
      const before = configStore.current();
      const original = await loadConfig(reloader.configPath);
      try {
        const unknown = await commands.run({ name: 'effort', argument: 'ultra' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(unknown.startsWith('无效的思考强度: ultra。\n')).toBe(true);
        expect(unknown).toContain(`可选: ${SUPPORTED}`);
        const unsupported = await commands.run({ name: 'effort', argument: 'xhigh' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(unsupported).toBe(`agent / agent-model 不支持思考强度 xhigh。可选: ${SUPPORTED}`);
        expect(configStore.current()).toBe(before);
        expect((await loadConfig(reloader.configPath)).fileConfig).toEqual(original.fileConfig);
      } finally {
        store.close();
      }
    });

    test('/effort default removes only the level override and is idempotent', async () => {
      const { store, commands, reloader, configStore } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats = [{ id: 123456789, provider: 'agent', model: 'agent-model', thinking_level: 'high' }];
      });
      try {
        const reply = await commands.run({ name: 'effort', argument: 'default' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(reply).toBe('已清除本群思考强度覆盖，跟随全局 low，将在下一次 agent session 生效。');
        expect((await loadConfig(reloader.configPath)).fileConfig.telegram?.chats).toEqual([
          { id: 123456789, provider: 'agent', model: 'agent-model' },
        ]);
        const status = (await commands.run({ name: 'status' }, CHAT_ID, ALICE, FIXED_NOW)).split('\n');
        expect(status[0]).toBe('本群模型: agent / agent-model');
        expect(status[1]).toBe('思考强度: low（继承全局）');
        const generation = configStore.current().generation;
        const again = await commands.run({ name: 'effort', argument: 'default' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(again).toContain('已清除本群思考强度覆盖');
        expect(configStore.current().generation).toBe(generation);
      } finally {
        store.close();
      }
    });

    test('a command in a migrated Chat writes the configured old ID', async () => {
      const oldId = -123456789;
      const newId = -1001234567890;
      const { store, commands, reloader } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats = [{ id: oldId, thinking_level: 'low' }];
      });
      try {
        store.orm
          .insert(chatMigrations)
          .values({ oldChatId: BigInt(oldId), newChatId: BigInt(newId), receivedAt: FIXED_NOW.toISOString() })
          .run();
        expect(await commands.run({ name: 'effort' }, BigInt(newId), ALICE, FIXED_NOW)).toContain('思考强度: low\n');
        expect(await commands.run({ name: 'effort', argument: 'high' }, BigInt(newId), ALICE, FIXED_NOW)).toContain(
          '已为本群设置思考强度: high',
        );
        expect((await loadConfig(reloader.configPath)).fileConfig.telegram?.chats).toEqual([
          { id: oldId, thinking_level: 'high' },
        ]);
      } finally {
        store.close();
      }
    });

    test('reports failed writes and other applied changes', async () => {
      const { store, commands, reloader } = await commandSetup();
      const write = vi.spyOn(reloader, 'setChatThinkingLevel');
      try {
        for (const fileWritten of [false, true]) {
          write.mockResolvedValueOnce({
            ok: false,
            code: 'config_write_failed',
            message: 'disk full',
            fileWritten,
            status: reloader.status(),
          });
          const reply = await commands.run({ name: 'effort', argument: 'high' }, CHAT_ID, ALICE, FIXED_NOW);
          expect(reply).toBe(fileWritten ? '已写入 config.jsonc，但应用失败: disk full' : '设置失败: disk full');
        }
        write.mockResolvedValueOnce({
          ok: true,
          applied: ['agent.history_messages'],
          restartRequired: ['telegram.bucket_window_seconds'],
          outsideServe: [],
          status: reloader.status(),
        });
        const reply = await commands.run({ name: 'effort', argument: 'low' }, CHAT_ID, ALICE, FIXED_NOW);
        expect(reply).toContain('已为本群设置思考强度: low');
        expect(reply).toContain('同时应用了配置文件中的其它修改: agent.history_messages');
        expect(reply).toContain('另有 1 项配置需要重启后生效。');
      } finally {
        write.mockRestore();
        store.close();
      }
    });

    test('reports an unavailable runtime without a reloader', async () => {
      const { store, scheduler, configStore } = await setup();
      const commands = new BotCommandService(store, configStore, scheduler);
      expect(await commands.run({ name: 'effort' }, CHAT_ID, ALICE, FIXED_NOW)).toBe('运行时配置应用不可用。');
      store.close();
    });
  });
});
