import { expect, test } from 'vitest';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { resolveAgentSettings } from '../../src/platform/config/resolve.ts';
import {
  CHAT_ID,
  AGENT_MODEL,
  SECOND_MODEL,
  logEvents,
  customProvider,
  builtinProvider,
  model,
  fauxAgent,
  setup,
} from './reload-fixtures.ts';

test('Chat switches resolve file IDs after a reorder and preserve other Chats and defaults', async () => {
  const secondChat = -1009876543210;
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats.push({ id: secondChat });
    },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats.reverse();
    });
    const before = fixture.configStore.beginInvocation();
    const result = await fixture.reloader.setChatModel(CHAT_ID, 'faux', SECOND_MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(
      expect.arrayContaining([
        `telegram.chats[${CHAT_ID}].provider`,
        `telegram.chats[${CHAT_ID}].model`,
        `telegram.chats[${CHAT_ID}].thinking_level`,
      ]),
    );
    const written = await loadConfig(fixture.configPath);
    const active = fixture.configStore.current().config;
    expect(written.config.telegram.chats.find((chat) => chat.id === CHAT_ID)).toMatchObject({
      provider: 'faux',
      model: SECOND_MODEL,
      thinking_level: 'off',
    });
    expect(active.telegram.chats.find((chat) => chat.id === CHAT_ID)?.model).toBe(SECOND_MODEL);
    expect(written.config.telegram.chats.find((chat) => chat.id === secondChat)?.model).toBeUndefined();
    expect(active.agent).toEqual(before.config.agent);
    expect(before.config.telegram.chats.find((chat) => chat.id === CHAT_ID)?.model).toBeUndefined();
    expect(logEvents('config_reloaded').at(-1)?.applied).toContain(`telegram.chats[${CHAT_ID}].model`);

    const reset = await fixture.reloader.resetChatModel(CHAT_ID);
    expect(reset.ok).toBe(true);
    const inherited = await loadConfig(fixture.configPath);
    const chat = inherited.config.telegram.chats.find((entry) => entry.id === CHAT_ID);
    expect(chat).not.toHaveProperty('provider');
    expect(chat).not.toHaveProperty('model');
    expect(chat).not.toHaveProperty('thinking_level');
    expect(resolveAgentSettings(inherited.config, chat)).toEqual(resolveAgentSettings(inherited.config));
    const noOp = await fixture.reloader.resetChatModel(CHAT_ID);
    expect(noOp.ok).toBe(true);
    expect(noOp.status.generation).toBe(reset.status.generation);
  } finally {
    fixture.store.close();
  }
});

test('Chat switches reject missing file IDs without writing', async () => {
  const fixture = await setup();
  try {
    const before = fixture.configStore.current();
    const original = await fixture.readText();
    const unknown = await fixture.reloader.setChatModel(-999, 'faux', SECOND_MODEL);
    expect(unknown).toMatchObject({ ok: false, code: 'config_invalid', fileWritten: false });
    expect(await fixture.readText()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);
    await fixture.patch((config) => {
      config.telegram.chats = [{ id: -999 }];
    });
    const removed = await fixture.readText();
    const missing = await fixture.reloader.setChatModel(CHAT_ID, 'faux', SECOND_MODEL);
    expect(missing).toMatchObject({ ok: false, code: 'config_invalid', fileWritten: false });
    expect(await fixture.readText()).toBe(removed);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('reload validates every selected Chat model before publishing and rejects deleting its definition', async () => {
  const fixture = await setup();
  try {
    fixture.runtimeWith(fauxAgent());
    const before = fixture.configStore.current();
    await fixture.patch((config) => {
      builtinProvider(config.providers, 'faux').models.push(
        model('tiny-chat', { reasoning: true, context_window: 1_000, max_tokens: 512 }),
      );
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'faux', model: 'tiny-chat' });
    });
    const rejected = await fixture.reloader.reloadFromFile();
    expect(rejected).toMatchObject({ ok: false, code: 'model_unusable' });
    expect(fixture.configStore.current()).toBe(before);
    expect(logEvents('config_reload_failed').at(-1)?.code).toBe('model_unusable');
    await fixture.patch((config) => {
      const provider = builtinProvider(config.providers, 'faux');
      provider.models = provider.models.filter((entry) => entry.id !== 'tiny-chat');
    });
    const missing = await fixture.reloader.reloadFromFile();
    expect(missing).toMatchObject({ ok: false, code: 'config_invalid' });
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test.each(['model', 'provider'] as const)('a hot-removed Chat no longer protects its %s reference', async (removed) => {
  const fixture = await setup({
    transform: (config) => {
      config.providers.chat = {
        ...customProvider(config.providers, 'agent'),
        models: [model('chat-only'), model('spare')],
      };
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'chat', model: 'chat-only', thinking_level: 'off' });
      config.telegram.chats.push({ id: -999 });
    },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats = config.telegram.chats.filter((chat) => chat.id !== CHAT_ID);
      if (removed === 'provider') {
        delete config.providers.chat;
      } else {
        customProvider(config.providers, 'chat').models = [model('spare')];
      }
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    expect(fixture.configStore.current().config.telegram.chats.some((chat) => chat.id === CHAT_ID)).toBe(false);
    expect(fixture.configStore.current().models.getModel('chat', 'chat-only')).toBeUndefined();
  } finally {
    fixture.store.close();
  }
});

test('global model changes refuse inherited thinking incompatibility and preserve Chat overrides', async () => {
  const fixture = await setup({
    transform: (config) => {
      Object.assign(config.telegram.chats[0] ?? {}, { thinking_level: 'high' });
    },
  });
  try {
    const original = await fixture.readText();
    const before = fixture.configStore.current();
    const rejected = await fixture.reloader.setAgentModel('vision', 'vision-model');
    expect(rejected).toMatchObject({ ok: false, code: 'config_invalid', fileWritten: false });
    expect(await fixture.readText()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);
    expect((await fixture.reloader.setChatModel(CHAT_ID, 'faux', SECOND_MODEL)).ok).toBe(true);
    expect((await fixture.reloader.setAgentModel('agent', 'agent-model')).ok).toBe(true);
    const config = fixture.configStore.current().config;
    expect(resolveAgentSettings(config, config.telegram.chats[0])).toMatchObject({
      provider: 'faux',
      model: SECOND_MODEL,
      thinking_level: 'off',
    });
    expect(config.agent!.provider).toBe('agent');
  } finally {
    fixture.store.close();
  }
});

test('concurrent switches in different Chats retain both overrides', async () => {
  const secondChat = -1009876543210;
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats.push({ id: secondChat });
    },
  });
  try {
    const results = await Promise.all([
      fixture.reloader.setChatModel(CHAT_ID, 'faux', SECOND_MODEL),
      fixture.reloader.setChatModel(secondChat, 'agent', 'agent-model'),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const written = await loadConfig(fixture.configPath);
    expect(written.config.telegram.chats.find((chat) => chat.id === CHAT_ID)?.model).toBe(SECOND_MODEL);
    expect(written.config.telegram.chats.find((chat) => chat.id === secondChat)?.model).toBe('agent-model');
    expect(written.config.agent!.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('two concurrent model switches both complete and agree on the last one', async () => {
  const fixture = await setup();
  try {
    const [first, second] = await Promise.all([
      fixture.reloader.setAgentModel('agent', 'agent-model'),
      fixture.reloader.setAgentModel('vision', 'vision-model'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fixture.configStore.current().config.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });
    const written = JSON.parse(await fixture.readText()) as FileConfig;
    expect(written.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });
  } finally {
    fixture.store.close();
  }
});
