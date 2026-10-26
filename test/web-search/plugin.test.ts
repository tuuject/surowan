import { expect, test } from 'vitest';
import { previewContext } from '../../src/platform/invocation-context.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { contribute, definePlugin, loadPlugins } from '../../src/plugins/plugin.ts';
import { WEB_SEARCH_PROVIDERS } from '../../src/plugins/web-search/extension.ts';
import webSearch from '../../src/plugins/web-search/index.ts';
import tavilyPlugin from '../../src/plugins/web-search/providers/tavily.ts';
import { tavily as tavilySpec } from '../../src/plugins/web-search/providers/tavily.ts';
import type { BusinessStore } from '../../src/store/store.ts';
import type { LongTaskService } from '../../src/store/long-tasks/index.ts';

const tasks = {
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
  invocationScope: () => {
    throw new Error('not used');
  },
} as unknown as LongTaskService;

/**
 * Only the audit insert is reachable: the capability list never touches the
 * database, and the one executed tool is rejected before it opens a call row.
 */
const store = {
  orm: {
    insert: () => ({ values: () => ({ run: () => ({ changes: 1 }) }) }),
  },
} as unknown as BusinessStore;

function config(enabled: boolean): RawConfig {
  return {
    web_search: {
      ...(enabled ? {} : { enabled: false }),
      engines: [{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, note: 'Chinese developer blogs' }],
    },
  } as unknown as RawConfig;
}

test('the bundled plugins register all seven providers on one extension point', () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  expect(loaded.extensions(WEB_SEARCH_PROVIDERS).map((provider) => provider.rule.id)).toEqual([
    'tavily',
    'brave',
    'exa',
    'firecrawl',
    'deepseek',
    'searxng',
    'youcom',
  ]);
});

test('the skill index and the capability follow availability together', () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  const deadline = Date.now() + 30_000;
  const context = previewContext('telegram');
  const on = loaded.capabilities(store, config(true), context, deadline, tasks);
  expect(on.map((entry) => entry.tool.name)).toContain('web_search');
  const offline = loaded.capabilities(store, config(false), context, deadline, tasks);
  expect(offline.map((entry) => entry.tool.name)).not.toContain('web_search');
  expect(loaded.skillAvailable('web-search', config(true))).toBe(true);
  expect(loaded.skillAvailable('web-search', config(false))).toBe(false);
});

test('the capability description lists the configured engine and its note', () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  const capabilities = loaded.capabilities(store, config(true), previewContext('telegram'), Date.now() + 30_000, tasks);
  const tool = capabilities.find((entry) => entry.tool.name === 'web_search')?.tool;
  expect(tool?.description).toContain('main (Tavily): Chinese developer blogs');
});

test('the live steer sink reaches the capability that detects a changed engine list', async () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  const config = {
    web_search: {
      engines: [
        { id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } },
        { id: 'docs', provider: 'exa', api_key: { jar: 'exa' }, enabled: false },
      ],
    },
  } as unknown as RawConfig;
  const steers: string[] = [];
  const capabilities = loaded.capabilities(
    store,
    config,
    previewContext('telegram'),
    Date.now() + 30_000,
    tasks,
    undefined,
    {
      steer: (text) => {
        steers.push(text);
      },
    },
  );
  const tool = capabilities.find((entry) => entry.tool.name === 'web_search')?.tool;
  if (tool === undefined) {
    throw new Error('Expected the web_search capability');
  }
  await expect(tool.execute('steer-1', { query: 'x', engine: 'docs' })).rejects.toThrow('is disabled');
  expect(steers).toHaveLength(1);
  expect(steers[0]).toContain('enabled engines are now main');
});

test('an unavailable plugin contributes neither the capability nor the skill', () => {
  const loaded = loadPlugins([webSearch]);
  const capabilities = loaded.capabilities(
    store,
    config(false),
    previewContext('playground'),
    Date.now() + 30_000,
    tasks,
  );
  expect(capabilities).toEqual([]);
  expect(loaded.skillAvailable('web-search', config(false))).toBe(false);
});

test('a second provider plugin claiming an existing id is rejected at load', () => {
  const twin = definePlugin({
    id: 'web-search-twin',
    dependencies: ['web-search'],
    extensions: [contribute(WEB_SEARCH_PROVIDERS, tavilySpec)],
  });
  expect(() => loadPlugins([webSearch, tavilyPlugin, twin])).toThrow(
    'Duplicate web-search.providers contribution tavily',
  );
});
