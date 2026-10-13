import { expect, test } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { definePlugin, loadPlugins } from '../src/plugins/plugin.ts';

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

test('a context injector round-trips collect → render → carried accumulation and rebuild', () => {
  // A minimal test injector: one tagged line per batch message, and the tag
  // itself is the dedupe signature — the same opaque-string contract the
  // runtime maintains across batches.
  const injector = {
    name: 'test',
    *collect(text: string): Generator<string> {
      for (const match of text.matchAll(/^- \[(t_\S+)\] /gm)) {
        yield match[1] as string;
      }
    },
    render(input: {
      readonly messageTexts: readonly string[];
      readonly remainingCharacters: number;
      readonly carried: ReadonlySet<string>;
    }) {
      const lines = input.messageTexts
        .filter((text) => !input.carried.has(`t_${text}`))
        .map((text) => `- [t_${text}] ${text}`);
      if (lines.length === 0) {
        return { text: '', signatures: [], count: 0 };
      }
      return {
        text: ['<untrusted_test>', ...lines, '</untrusted_test>'].join('\n'),
        signatures: lines.map((line) => line.slice('- ['.length).split(']')[0] as string),
        count: lines.length,
      };
    },
  };
  const render = (messageTexts: readonly string[], carried: ReadonlySet<string>) =>
    injector.render({ messageTexts, remainingCharacters: 10_000, carried });

  // First batch: both messages inject, and the signatures ride the result.
  const first = render(['a', 'b'], new Set());
  expect(first.count).toBe(2);
  expect(first.signatures).toEqual(['t_a', 't_b']);
  // Carried accumulation: reading the block back out of the retained message
  // yields exactly the signatures the render reported.
  expect([...injector.collect(first.text)]).toEqual(['t_a', 't_b']);

  // Next batch: the carried set suppresses what the transcript still holds.
  const carried = new Set([...injector.collect(first.text)]);
  const second = render(['a'], carried);
  expect(second.text).toBe('');
  expect(second.count).toBe(0);

  // A GC drops the retained batch; rebuilding the carried state from what
  // actually survived (here: nothing) makes the entry injectable again.
  const rebuilt = render(['a'], new Set());
  expect(rebuilt.count).toBe(1);
  expect(rebuilt.signatures).toEqual(['t_a']);
});
