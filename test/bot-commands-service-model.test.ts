import { afterAll, describe, expect, test, vi } from 'vitest';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { chatMigrations } from '../src/store/schema.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import type { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { ALICE, type ConfigTransform, FIXED_NOW, cleanupDirectories, setup } from './bot-commands-fixtures.ts';

afterAll(cleanupDirectories);

describe('bot command service', () => {
  describe('model command', () => {
    function manyModelTransform(count: number): ConfigTransform {
      return (config) => {
        config.telegram.admins = [42];
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.models.push(
          ...Array.from({ length: count }, (_, index) => ({
            id: `agent-extra-${index + 1}`,
            name: `Agent Extra ${index + 1}`,
            reasoning: false,
            input: ['text' as const],
            context_window: 128000,
            max_tokens: 8192,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          })),
        );
      };
    }

    async function commandSetup(transform?: ConfigTransform): Promise<{
      store: SqliteStore;
      commands: BotCommandService;
      switcher: AgentModelSwitcher;
      reloader: ConfigReloader;
      configStore: RuntimeConfigurationStore;
    }> {
      const { store, loaded, scheduler, configStore } = await setup(transform);
      const switcher = new AgentModelSwitcher(configStore);
      const configReloader = new ConfigReloader({
        loaded,
        store: configStore,
        modelSwitcher: switcher,
        secrets: new SecretStore(),
        validateAgentModel: () => undefined,
        onPublished: () => undefined,
      });
      const commands = new BotCommandService(store, configStore, scheduler, switcher, undefined, configReloader);
      return { store, commands, switcher, reloader: configReloader, configStore };
    }

    test('is denied for non-admins without changing the model', async () => {
      const { store, commands, configStore } = await commandSetup();
      const before = configStore.current();
      const stranger: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
      expect(await commands.run({ name: 'model' }, 123456789n, stranger, FIXED_NOW)).toBe(
        '该命令仅对本 Bot 的管理员可用。',
      );
      expect(await commands.run({ name: 'model', argument: '2' }, 123456789n, stranger, FIXED_NOW)).toBe(
        '该命令仅对本 Bot 的管理员可用。',
      );
      expect(await commands.run({ name: 'model', argument: 'default' }, 123456789n, stranger, FIXED_NOW)).toBe(
        '该命令仅对本 Bot 的管理员可用。',
      );
      expect(configStore.current()).toBe(before);
      store.close();
    });

    test('without an argument lists the first page of switchable options with inheritance hints', async () => {
      const { store, commands } = await commandSetup();
      const reply = await commands.run({ name: 'model' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toContain('本群模型: agent / agent-model（继承全局）');
      expect(reply).toContain('思考强度: low（继承全局）');
      expect(reply).toContain('可用模型（第 1/1 页，共 2 条）:');
      expect(reply).toContain('1. agent / agent-model（Agent Model）');
      expect(reply).toContain('2. vision / vision-model（Vision Model）');
      expect(reply).toContain('使用 /model 序号 切换，/model page 页码 翻页，/model default 清除本群覆盖');
      store.close();
    });

    test('paginates model options by global index in pages of 20', async () => {
      const { store, commands } = await commandSetup(manyModelTransform(40));
      const firstPage = (await commands.run({ name: 'model' }, 123456789n, ALICE, FIXED_NOW)).split('\n');
      expect(firstPage).toContain('可用模型（第 1/3 页，共 42 条）:');
      expect(firstPage).toContain('1. agent / agent-model（Agent Model）');
      expect(firstPage).toContain('20. agent / agent-extra-19（Agent Extra 19）');
      expect(firstPage.some((line: string) => line.startsWith('21. '))).toBe(false);

      const secondPage = (
        await commands.run({ name: 'model', argument: 'page 2' }, 123456789n, ALICE, FIXED_NOW)
      ).split('\n');
      expect(secondPage).toContain('可用模型（第 2/3 页，共 42 条）:');
      expect(secondPage).toContain('21. agent / agent-extra-20（Agent Extra 20）');
      expect(secondPage).toContain('40. agent / agent-extra-39（Agent Extra 39）');
      expect(secondPage.filter((line: string) => /^\d+\. /.test(line))).toHaveLength(20);

      const thirdPage = (await commands.run({ name: 'model', argument: 'page 3' }, 123456789n, ALICE, FIXED_NOW)).split(
        '\n',
      );
      expect(thirdPage).toContain('可用模型（第 3/3 页，共 42 条）:');
      expect(thirdPage).toContain('41. agent / agent-extra-40（Agent Extra 40）');
      expect(thirdPage).toContain('42. vision / vision-model（Vision Model）');
      expect(thirdPage.filter((line: string) => /^\d+\. /.test(line))).toHaveLength(2);
      store.close();
    });

    test('numeric argument writes only the current Chat and resets its thinking level', async () => {
      const { store, commands, switcher, reloader, configStore } = await commandSetup((config) => {
        manyModelTransform(40)(config);
        config.telegram.chats.push({ id: -1001234567890 });
      });
      try {
        const reply = await commands.run({ name: 'model', argument: '21' }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toContain('已为本群切换: agent / agent-extra-20');
        expect(reply).toContain('思考强度已重置为该模型最弱的一档: off');
        expect(switcher.current()?.model).toBe('agent-model');
        const loaded = await loadConfig(reloader.configPath);
        expect(loaded.fileConfig.telegram?.chats[0]).toMatchObject({
          provider: 'agent',
          model: 'agent-extra-20',
          thinking_level: 'off',
        });
        expect(loaded.fileConfig.telegram?.chats[1]?.model).toBeUndefined();
        expect(configStore.current().config.telegram.chats[0]?.model).toBe('agent-extra-20');
        expect(await commands.run({ name: 'status' }, -1001234567890n, ALICE, FIXED_NOW)).toContain(
          '本群模型: agent / agent-model（继承全局）',
        );
      } finally {
        store.close();
      }
    });

    test('rejects pages outside the available range and shows menu with chat model', async () => {
      const { store, commands, configStore } = await commandSetup(manyModelTransform(40));
      const before = configStore.current();
      for (const argument of ['page 0', 'page 4', 'page 999999999999999999999999999999999999999']) {
        const reply = await commands.run({ name: 'model', argument }, 123456789n, ALICE, FIXED_NOW);
        expect(reply.startsWith('无效页码。')).toBe(true);
        expect(reply).toContain('本群模型: agent / agent-model（继承全局）');
        expect(reply).toContain('可用模型（第 1/3 页，共 42 条）:');
        expect(configStore.current()).toBe(before);
      }
      store.close();
    });

    test('switches by index and the status command reflects it for the chat', async () => {
      const { store, commands } = await commandSetup();
      const reply = await commands.run({ name: 'model', argument: '2' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toContain('已为本群切换: vision / vision-model');
      expect(reply).toContain('已写入 config.jsonc，将在下一次 agent session 生效');
      const status = await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW);
      expect(status).toContain('本群模型: vision / vision-model\n思考强度: off');
      expect(status).not.toContain('（继承全局）');
      store.close();
    });

    test('/model default clears all chat overrides and is idempotent', async () => {
      const { store, commands, reloader, configStore } = await commandSetup();
      try {
        await commands.run({ name: 'model', argument: '2' }, 123456789n, ALICE, FIXED_NOW);
        const reply = await commands.run({ name: 'model', argument: 'default' }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toContain('已清除本群模型覆盖');
        expect(reply).toContain('跟随全局 agent / agent-model');
        expect(reply).toContain('将在下一次 agent session 生效');
        const loaded = await loadConfig(reloader.configPath);
        for (const key of ['provider', 'model', 'thinking_level']) {
          expect(loaded.fileConfig.telegram?.chats[0]).not.toHaveProperty(key);
        }
        const generation = configStore.current().generation;
        await commands.run({ name: 'model', argument: 'default' }, 123456789n, ALICE, FIXED_NOW);
        expect(configStore.current().generation).toBe(generation);
        expect(await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain(
          '思考强度: low（继承全局）',
        );
      } finally {
        store.close();
      }
    });

    test('a command in a migrated Chat writes the configured old ID for all its topics', async () => {
      const oldId = -123456789;
      const newId = -1001234567890;
      const { store, commands, reloader } = await commandSetup((config) => {
        config.telegram.admins = [42];
        config.telegram.chats = [{ id: oldId, thinking_level: 'high' }];
      });
      try {
        store.orm
          .insert(chatMigrations)
          .values({ oldChatId: BigInt(oldId), newChatId: BigInt(newId), receivedAt: FIXED_NOW.toISOString() })
          .run();
        expect(await commands.run({ name: 'model' }, BigInt(newId), ALICE, FIXED_NOW)).toContain('思考强度: high\n');
        const switched = await commands.run(
          { name: 'model', argument: '2', threadId: 7n },
          BigInt(newId),
          ALICE,
          FIXED_NOW,
        );
        expect(switched).toContain('已为本群切换: vision / vision-model');
        expect(await commands.run({ name: 'model', threadId: 8n }, BigInt(newId), ALICE, FIXED_NOW)).toContain(
          '本群模型: vision / vision-model\n',
        );
        const loaded = await loadConfig(reloader.configPath);
        expect(loaded.fileConfig.telegram?.chats).toEqual([
          { id: oldId, provider: 'vision', model: 'vision-model', thinking_level: 'off' },
        ]);
        await commands.run({ name: 'model', argument: 'default', threadId: 8n }, BigInt(newId), ALICE, FIXED_NOW);
        expect((await loadConfig(reloader.configPath)).fileConfig.telegram?.chats).toEqual([{ id: oldId }]);
      } finally {
        store.close();
      }
    });

    test('rejects invalid arguments without changing the model', async () => {
      const { store, commands, configStore } = await commandSetup();
      const before = configStore.current();
      for (const argument of ['0', '3', '500', 'abc', '1x', 'reset']) {
        const reply = await commands.run({ name: 'model', argument }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toContain('无效序号');
        expect(configStore.current()).toBe(before);
      }
      store.close();
    });

    test('/model default distinguishes failed writes from a saved but unapplied file', async () => {
      const { store, commands, reloader } = await commandSetup();
      const reset = vi.spyOn(reloader, 'resetChatModel');
      try {
        for (const fileWritten of [false, true]) {
          reset.mockResolvedValueOnce({
            ok: false,
            code: 'config_write_failed',
            message: 'disk full',
            fileWritten,
            status: reloader.status(),
          });
          const reply = await commands.run({ name: 'model', argument: 'default' }, 123456789n, ALICE, FIXED_NOW);
          expect(reply).toBe(fileWritten ? '已写入 config.jsonc，但应用失败: disk full' : '恢复失败: disk full');
        }
        reset.mockResolvedValueOnce({
          ok: true,
          applied: ['agent.history_messages'],
          restartRequired: ['telegram.bucket_window_seconds'],
          outsideServe: [],
          status: reloader.status(),
        });
        const reply = await commands.run({ name: 'model', argument: 'default' }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toContain('同时应用了配置文件中的其它修改: agent.history_messages');
        expect(reply).toContain('另有 1 项配置需要重启后生效。');
      } finally {
        reset.mockRestore();
        store.close();
      }
    });

    test('reports runtime model switch unavailable without reloader or switcher', async () => {
      const { store, scheduler, configStore } = await setup();
      const commands = new BotCommandService(store, configStore, scheduler);
      const reply = await commands.run({ name: 'model' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toBe('运行时模型切换不可用。');
      store.close();
    });

    test('reports chat not found when chat id is not in config', async () => {
      const { store, commands } = await commandSetup();
      const reply = await commands.run({ name: 'model' }, 999999999n, ALICE, FIXED_NOW);
      expect(reply).toBe('本 Chat 未在配置中找到。');
      store.close();
    });

    test('status shows inheritance hints when following global settings', async () => {
      const { store, commands } = await commandSetup();
      const status = await commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW);
      expect(status).toContain('本群模型: agent / agent-model（继承全局）');
      expect(status).toContain('思考强度: low（继承全局）');
      store.close();
    });
  });
});
