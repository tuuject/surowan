import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { classify } from '../../src/platform/config/diff-merge.ts';
import {
  enabledSearchEngines,
  resolveSearchEngines,
  webSearchAvailable,
  type WebSearchConfig,
} from '../../src/platform/web-search.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from '../helpers.ts';

async function withConfig(
  transform: (file: FixtureConfig) => void,
  run: (loaded: Awaited<ReturnType<typeof loadConfig>>) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-web-search-config-'));
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
    run(await loadConfig(configPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectInvalid(transform: (file: FixtureConfig) => void, message: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-web-search-config-'));
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
    await expect(loadConfig(configPath)).rejects.toThrow(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const tavilyEngine = {
  id: 'main',
  provider: 'tavily',
  api_key: { jar: 'tavily' },
  note: 'Chinese developer blogs',
};

test('a complete section loads and resolves defaults', async () => {
  await withConfig(
    (file) => {
      file.web_search = { enabled: true, engines: [tavilyEngine] };
    },
    (loaded) => {
      expect(webSearchAvailable(loaded.config)).toBe(true);
      const [engine] = resolveSearchEngines(loaded.config);
      expect(engine).toMatchObject({
        id: 'main',
        enabled: true,
        endpoint: 'https://api.tavily.com/search',
        results: 5,
        timeoutSeconds: 15,
        note: 'Chinese developer blogs',
      });
    },
  );
});

test('an absent section, the switch off and every engine disabled are one state', async () => {
  await withConfig(
    () => {
      // no web_search section at all
    },
    (loaded) => {
      expect(webSearchAvailable(loaded.config)).toBe(false);
      expect(resolveSearchEngines(loaded.config)).toEqual([]);
    },
  );
  await withConfig(
    (file) => {
      file.web_search = { enabled: false, engines: [tavilyEngine] };
    },
    (loaded) => {
      // The switch wins over individually enabled engines.
      expect(webSearchAvailable(loaded.config)).toBe(false);
      expect(enabledSearchEngines(loaded.config).map((engine) => engine.id)).toEqual(['main']);
    },
  );
  await withConfig(
    (file) => {
      file.web_search = { engines: [{ ...tavilyEngine, enabled: false }] };
    },
    (loaded) => {
      expect(webSearchAvailable(loaded.config)).toBe(false);
    },
  );
});

test('unregistered providers and missing required fields are configuration errors', async () => {
  await expectInvalid((file) => {
    file.web_search = { engines: [{ id: 'x', provider: 'nope' }] };
  }, 'references unknown provider nope');
  await expectInvalid((file) => {
    file.web_search = { engines: [{ id: 'x', provider: 'tavily' }] };
  }, 'requires an api_key');
  await expectInvalid((file) => {
    file.web_search = { engines: [{ id: 'x', provider: 'searxng' }] };
  }, 'requires an endpoint');
  await expectInvalid((file) => {
    file.web_search = {
      engines: [{ id: 'x', provider: 'searxng', endpoint: 'https://sx.example', api_key: { jar: 'x' } }],
    };
  }, 'does not accept an api_key');
  await expectInvalid((file) => {
    file.web_search = {
      engines: [{ id: 'x', provider: 'searxng', endpoint: 'https://sx.example', results: 5 }],
    };
  }, 'does not accept a result count');
});

test('duplicate ids, bad endpoints and bad URL filters are rejected', async () => {
  await expectInvalid((file) => {
    file.web_search = {
      engines: [tavilyEngine, { ...tavilyEngine, provider: 'brave' }],
    };
  }, 'Duplicate web_search engine id: main');
  await expectInvalid((file) => {
    file.web_search = {
      engines: [{ id: 'x', provider: 'searxng', endpoint: 'https://user:pass@sx.example' }],
    };
  }, 'without credentials');
  await expectInvalid((file) => {
    file.web_search = { url_filters: ['('], engines: [tavilyEngine] };
  }, 'Invalid web_search URL filter');
});

test('a plaintext key is refused with the key-jar hint', async () => {
  await expectInvalid((file) => {
    file.web_search = {
      engines: [{ id: 'main', provider: 'tavily', api_key: 'tvly-plaintext' as never }],
    };
  }, 'plaintext secrets are not accepted');
});

test('the schema bounds results and timeouts', async () => {
  await expectInvalid((file) => {
    file.web_search = { engines: [{ ...tavilyEngine, results: 11 }] };
  }, 'Invalid config');
  await expectInvalid((file) => {
    file.web_search = { engines: [{ ...tavilyEngine, timeout_seconds: 31 }] };
  }, 'Invalid config');
});

test('the search section is hot: a reload applies it without a restart', () => {
  expect(classify('web_search')).toBe('hot');
  expect(classify('web_search.engines')).toBe('hot');
  expect(classify('web_search.url_filters')).toBe('hot');
});

test('the section view keeps disabled engines but resolves only enabled ones', () => {
  const config = {
    web_search: {
      engines: [
        { id: 'a', provider: 'tavily', api_key: { jar: 'a' } },
        { id: 'b', provider: 'brave', api_key: { jar: 'b' }, enabled: false },
      ],
    } satisfies WebSearchConfig,
  };
  expect(resolveSearchEngines(config).map((engine) => engine.id)).toEqual(['a', 'b']);
  expect(enabledSearchEngines(config).map((engine) => engine.id)).toEqual(['a']);
});

test('a provider registered by no plugin is rejected even when it is otherwise valid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-web-search-config-'));
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (file) => {
        file.web_search = { engines: [{ id: 'x', provider: 'tavily', api_key: { jar: 'tavily' } }] };
      }),
    );
    await expect(loadConfig(configPath, { searchProviders: [{ ...builtinTavily(), id: 'other' }] })).rejects.toThrow(
      'references unknown provider tavily',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function builtinTavily() {
  return {
    id: 'tavily',
    label: 'Tavily',
    defaultEndpoint: 'https://api.tavily.com/search',
    keyPolicy: 'required' as const,
    queryLimit: 400,
    supportsResultCount: true,
  };
}
