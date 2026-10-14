import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { expect, test } from 'vitest';
import type { ContextInjectionInput, ContextInjector } from '../src/context/context-injector.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { definePlugin, loadPlugins } from '../src/plugins/plugin.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { renderInvocationContext, testConfigStore, writeTestConfig } from './helpers.ts';

test('loadPlugins rejects invalid and duplicate plugin ids', () => {
  expect(() => loadPlugins([definePlugin({ id: 'Web_Fetch' })])).toThrow('Plugin id is invalid: Web_Fetch');
  expect(() => loadPlugins([definePlugin({ id: 'twin' }), definePlugin({ id: 'twin' })])).toThrow(
    'Duplicate plugin id: twin',
  );
});

test('built-in plugins load with unique ids and their skill directories', () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  expect(loaded.skillDirectories.map((directory) => directory.split(/[\\/]/).at(-1))).toEqual([
    'web-fetch',
    'image-generation',
    'alarms',
    'dictionary',
  ]);
});

test('loadPlugins rejects invalid and duplicate context injector names', () => {
  const injector = { name: 'twin', collect: () => [], render: () => ({ text: '', signatures: [], count: 0 }) };
  expect(() =>
    loadPlugins([
      definePlugin({ id: 'one', contextInjectors: [injector] }),
      definePlugin({ id: 'two', contextInjectors: [injector] }),
    ]),
  ).toThrow('Duplicate context injector name: twin');
  expect(() =>
    loadPlugins([definePlugin({ id: 'one', contextInjectors: [{ ...injector, name: 'Bad_Name' }] })]),
  ).toThrow('Context injector name is invalid: Bad_Name');
});

test('the context builder runs injectors in order on a shrinking budget and places their blocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-plugins-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hello injectors',
        },
      } satisfies Update,
      received,
    );
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected a due invocation');
    }

    const inputs = new Map<string, ContextInjectionInput>();
    const injector = (name: string, text: string): ContextInjector => ({
      name,
      collect: () => [],
      render: (input) => {
        inputs.set(name, input);
        return text.length === 0
          ? { text: '', signatures: [], count: 0 }
          : { text, signatures: [`${name}-sig`], count: 1 };
      },
    });
    const firstBlock = '<untrusted_first>\nfirst body\n</untrusted_first>';
    const lastBlock = '<untrusted_last>\nlast body\n</untrusted_last>';
    const rendered = renderInvocationContext(store, loaded.config, invocationId, {
      injectors: [injector('first', firstBlock), injector('silent', ''), injector('last', lastBlock)],
      carriedInjections: new Map([['first', new Set(['first-old'])]]),
    });

    // Each injector sees the batch, its own carried set, and the budget the
    // earlier non-empty blocks left (block length plus its joining newline).
    const first = inputs.get('first');
    const silent = inputs.get('silent');
    const last = inputs.get('last');
    if (first === undefined || silent === undefined || last === undefined) {
      throw new Error('Expected every injector to render');
    }
    expect(first.messageTexts).toEqual(['hello injectors']);
    expect(first.privateChat).toBe(true);
    expect([...first.carried]).toEqual(['first-old']);
    expect([...silent.carried]).toEqual([]);
    expect(first.remainingCharacters).toBeGreaterThan(firstBlock.length);
    expect(silent.remainingCharacters).toBe(first.remainingCharacters - firstBlock.length - 1);
    expect(last.remainingCharacters).toBe(silent.remainingCharacters);

    // Contributions keep run order, including the empty one; only non-empty
    // blocks are rendered, between the runtime state and the new messages.
    expect(rendered.injections.map(({ name, signatures, count }) => ({ name, signatures, count }))).toEqual([
      { name: 'first', signatures: ['first-sig'], count: 1 },
      { name: 'silent', signatures: [], count: 0 },
      { name: 'last', signatures: ['last-sig'], count: 1 },
    ]);
    expect(rendered.userPrompt).toContain(`</runtime_state>\n${firstBlock}\n${lastBlock}\n<untrusted_new_messages>`);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
