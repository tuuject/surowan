import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { resolveToolModel } from '../../src/platform/tool-model.ts';
import { mergeDictionaryEntries, mergePreview } from '../../src/plugins/dictionary/admin.ts';
import { resolveDictionaryInjectionMode } from '../../src/plugins/dictionary/injection.ts';
import dictionaryPlugin from '../../src/plugins/dictionary/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { testConfigStore, writeTestConfig } from '../helpers.ts';
import { DictionaryStore } from '../../src/plugins/dictionary/store.ts';
import { directories, fixture } from './fixtures.ts';

test('the plugin contributes its capabilities with the pre-migration side-effect flags', async () => {
  const { store, loaded } = await fixture();
  try {
    const context: InvocationContext = {
      invocationId: 0n,
      conversationId: 0n,
      hostKind: 'telegram',
      chatId: 123456789n,
      threadId: 0n,
      systemPrompt: '',
      userPrompt: '',
      directImages: [],
      visibleSenders: new Map(),
      callerUserId: null,
      completion: null,
      omittedNewMessages: 0,
    };
    const capabilities = dictionaryPlugin.capabilities?.({
      config: loaded.config,
      context,
      deadline: Number.MAX_SAFE_INTEGER,
      audit: createToolAudit(store, 0n),
      orm: store.orm,
      tasks: {
        create: () => {
          throw new Error('not used');
        },
        get: () => {
          throw new Error('not used');
        },
        list: () => {
          throw new Error('not used');
        },
        complete: () => {
          throw new Error('not used');
        },
        fail: () => {
          throw new Error('not used');
        },
        cancel: () => {
          throw new Error('not used');
        },
      },
    });
    if (capabilities === undefined) {
      throw new Error('Expected the dictionary plugin to contribute capabilities');
    }
    expect(capabilities.map((entry) => entry.tool.name).sort()).toEqual([
      'add_dictionary_entry',
      'lookup_dictionary',
      'update_dictionary_entry',
    ]);
    expect(capabilities.map((entry) => entry.sideEffect)).toEqual([true, true, true]);
    expect(dictionaryPlugin.contextInjectors?.map((injector) => injector.name)).toEqual(['dictionary']);
  } finally {
    store.close();
  }
});

test('the injection mode resolves per chat, overriding the global default', () => {
  const config = {
    dictionary: { injection_mode: 'aggressive' as const },
    telegram: { chats: [{ id: 123456789, dictionary_injection_mode: 'off' as const }, { id: 999 }] },
  };
  expect(resolveDictionaryInjectionMode(config, 123456789n)).toBe('off');
  expect(resolveDictionaryInjectionMode(config, 999n)).toBe('aggressive');
  expect(resolveDictionaryInjectionMode(config, 5n)).toBe('aggressive');
  expect(resolveDictionaryInjectionMode({ telegram: { chats: [] } }, 5n)).toBe('on_demand');
});

test('the tool model inherits the global agent settings until one is configured', () => {
  const base = { agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' as const } };
  expect(resolveToolModel({ ...base } as never)).toEqual({
    provider: 'agent',
    model: 'agent-model',
    thinkingLevel: 'low',
    inherited: true,
  });
  expect(
    resolveToolModel({
      ...base,
      tool_model: { provider: 'vision', model: 'vision-model', thinking_level: 'off' },
    } as never),
  ).toEqual({ provider: 'vision', model: 'vision-model', thinkingLevel: 'off', inherited: false });
});

test('merge preview calls the tool model and persists nothing; confirm writes atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-dictionary-merge-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [
      { id: 'agent-model', reasoning: true, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const configStore = await testConfigStore(loaded, { models, visionModel: faux.getModel() });
  const store = await SqliteStore.open(loaded.config);
  try {
    const dictionary = new DictionaryStore(store.orm);
    const a = dictionary.create({
      term: '碗',
      definition: '昵称 A',
      aliases: ['塑料'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const b = dictionary.create({
      term: '塑料碗',
      definition: '昵称 B',
      aliases: ['碗'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });

    faux.setResponses([fauxAssistantMessage('{"term":"塑料碗","definition":"合并后的解释","aliases":["碗","塑料"]}')]);
    const preview = await mergePreview(
      {
        store: dictionary,
        orm: store.orm,
        models: configStore.current().models,
        secrets: new SecretStore(),
        toolModel: resolveToolModel(configStore.current().config)!,
      },
      [a.id, b.id],
    );
    expect(preview.suggestion).toEqual({ term: '塑料碗', definition: '合并后的解释', aliases: ['碗', '塑料'] });
    expect(preview.sources.map((source) => source.id)).toEqual([a.id, b.id]);
    // Preview persisted nothing, but audited the auxiliary call.
    expect(dictionary.list({ scope: 'global' })).toHaveLength(2);
    const calls = store.db
      .prepare<[], { role: string; state: string; provider: string; model: string }>(
        'SELECT role, state, provider, model FROM model_calls ORDER BY id',
      )
      .all();
    expect(calls).toEqual([{ role: 'tool', state: 'success', provider: 'agent', model: 'agent-model' }]);

    // Confirm creates the merged entry and keeps the sources by default.
    const kept = mergeDictionaryEntries(store.orm, {
      entry: {
        term: preview.suggestion.term,
        definition: preview.suggestion.definition,
        aliases: [...preview.suggestion.aliases],
        scope: 'global',
        chat_id: null,
        enabled: true,
      },
      sources: preview.sources.map((source) => ({ id: source.id, revision: source.revision })),
      delete_sources: false,
    });
    expect(kept.deleted_sources).toBe(0);
    expect(dictionary.list({ scope: 'global' })).toHaveLength(3);

    // Deleting the sources removes exactly the selected entries.
    const mergedId = kept.entry.id;
    const collapsed = mergeDictionaryEntries(store.orm, {
      entry: {
        term: '合并结果',
        definition: '合并',
        aliases: [],
        scope: 'global',
        chat_id: null,
        enabled: true,
      },
      sources: [
        { id: a.id, revision: a.revision },
        { id: b.id, revision: b.revision },
      ],
      delete_sources: true,
    });
    expect(collapsed.deleted_sources).toBe(2);
    const remaining = dictionary.list({ scope: 'global' }).map((entry) => entry.id);
    expect(remaining).toContain(mergedId);
    expect(remaining).toContain(collapsed.entry.id);
    expect(remaining).not.toContain(a.id);
    expect(remaining).not.toContain(b.id);

    // A stale source revision aborts the whole transaction.
    const fresh = dictionary.create({
      term: 'stale',
      definition: 'stale',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    expect(() =>
      mergeDictionaryEntries(store.orm, {
        entry: {
          term: 'x',
          definition: 'x',
          aliases: [],
          scope: 'global',
          chat_id: null,
          enabled: true,
        },
        sources: [{ id: fresh.id, revision: '99' }],
        delete_sources: true,
      }),
    ).toThrowError(/dictionary_conflict/);
    expect(dictionary.get(fresh.id)).toBeDefined();
  } finally {
    store.close();
  }
});

test('merge rejects an abnormal stop reason and an invalid suggestion, and audits each as an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-dictionary-merge-strict-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [
      { id: 'agent-model', reasoning: true, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const configStore = await testConfigStore(loaded, { models, visionModel: faux.getModel() });
  const store = await SqliteStore.open(loaded.config);
  try {
    const dictionary = new DictionaryStore(store.orm);
    const a = dictionary.create({
      term: '碗',
      definition: '昵称 A',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const b = dictionary.create({
      term: '塑料碗',
      definition: '昵称 B',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const dependencies = {
      store: dictionary,
      orm: store.orm,
      models: configStore.current().models,
      secrets: new SecretStore(),
      toolModel: resolveToolModel(configStore.current().config)!,
    };
    const calls = () =>
      store.db
        .prepare<[], { state: string; error_code: string | null; duration_ms: bigint | null }>(
          'SELECT state, error_code, duration_ms FROM model_calls ORDER BY id',
        )
        .all();

    // A truncated reply (`length`) is never parsed into a suggestion.
    faux.setResponses([fauxAssistantMessage('{"term":"x"', { stopReason: 'length' })]);
    await expect(mergePreview(dependencies, [a.id, b.id])).rejects.toThrowError(/stopped with length/);
    // A tool-use reply is likewise abnormal for a one-shot merge.
    faux.setResponses([fauxAssistantMessage(fauxToolCall('some_tool', {}), { stopReason: 'toolUse' })]);
    await expect(mergePreview(dependencies, [a.id, b.id])).rejects.toThrowError(/stopped with toolUse/);
    // Well-formed stop but an out-of-contract suggestion: aliases that are not
    // strings, or a field beyond the entry limits.
    faux.setResponses([fauxAssistantMessage('{"term":"合并","definition":"d","aliases":["ok",42]}')]);
    await expect(mergePreview(dependencies, [a.id, b.id])).rejects.toThrowError(/invalid suggestion/);
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ term: 'x'.repeat(500), definition: 'd', aliases: [] }))]);
    await expect(mergePreview(dependencies, [a.id, b.id])).rejects.toThrowError(/invalid suggestion/);
    // A blank alias is an error rather than a silently dropped one.
    faux.setResponses([fauxAssistantMessage('{"term":"合并","definition":"d","aliases":["ok","   "]}')]);
    await expect(mergePreview(dependencies, [a.id, b.id])).rejects.toThrowError(/blank alias/);

    // Every one of those calls is audited as an error with a recorded duration,
    // never as a success with an unparsed body.
    const audited = calls();
    expect(audited).toHaveLength(5);
    expect(audited.every((row) => row.state === 'error')).toBe(true);
    expect(audited.map((row) => row.error_code)).toEqual([
      'tool_model_length',
      'tool_model_toolUse',
      'tool_model_invalid_output',
      'tool_model_invalid_output',
      'tool_model_invalid_output',
    ]);
    expect(audited.every((row) => row.duration_ms !== null)).toBe(true);

    // A clean reply is the only one audited as success, and it persists nothing.
    faux.setResponses([fauxAssistantMessage('{"term":"合并","definition":"合并后的解释","aliases":["碗"]}')]);
    const preview = await mergePreview(dependencies, [a.id, b.id]);
    expect(preview.suggestion).toEqual({ term: '合并', definition: '合并后的解释', aliases: ['碗'] });
    expect(dictionary.list({ scope: 'global' })).toHaveLength(2);
    expect(calls().at(-1)).toMatchObject({ state: 'success', error_code: null });
  } finally {
    store.close();
  }
});
