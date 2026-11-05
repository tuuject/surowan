import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli } from '../src/cli-options.ts';
import { loadConfig } from '../src/adapters/local-monolith/config/index.ts';
import { extractThinkingLevels, type ModelsDevModel } from '../src/platform/models-dev.ts';
import { assertBaseUrl, fetchProviderModels, planModelsEndpoint } from '../src/platform/provider-models.ts';
import { agentThinkingLevels, saveConfig } from '../src/tui/configure.ts';
import { THINKING_LEVELS } from '../src/platform/thinking-levels.ts';
import { startFixtureServer, stopFixtureServer, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}

describe('configure save', () => {
  test('an invalid configuration never reaches the file', async () => {
    const { configPath } = await fixture();
    const original = await readFile(configPath, 'utf8');
    const { fileConfig } = await loadConfig(configPath);
    // Deleting the agent's provider leaves `agent.provider` dangling.
    const { agent: _agent, ...providers } = fileConfig.providers;
    expect(await saveConfig(configPath, { ...fileConfig, providers }, original)).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  test('a file changed during the session is not overwritten', async () => {
    const { configPath } = await fixture();
    const original = await readFile(configPath, 'utf8');
    const { fileConfig } = await loadConfig(configPath);
    const concurrent = original.replace('"thinking_level": "low"', '"thinking_level": "medium"');
    expect(concurrent).not.toBe(original);
    await writeFile(configPath, concurrent);
    const edited = { ...fileConfig, agent: { ...fileConfig.agent, thinking_level: 'off' as const } };
    expect(await saveConfig(configPath, edited, original)).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(concurrent);
  });

  test('a valid configuration is saved and loads back', async () => {
    const { configPath } = await fixture();
    const original = await readFile(configPath, 'utf8');
    const { fileConfig } = await loadConfig(configPath);
    const edited = { ...fileConfig, agent: { ...fileConfig.agent, thinking_level: 'off' as const } };
    expect(await saveConfig(configPath, edited, original)).toBe(true);
    expect((await loadConfig(configPath)).config.agent!.thinking_level).toBe('off');
  });
});

describe('models.dev client', () => {
  test('turns reasoning options into Pi thinking levels, weakest first', () => {
    const levels = (reasoning_options: ModelsDevModel['reasoning_options'], reasoning = true) =>
      extractThinkingLevels({
        id: 'reasoning-model',
        name: 'Reasoning Model',
        reasoning,
        ...(reasoning_options === undefined ? {} : { reasoning_options }),
        modalities: { input: ['text'], output: ['text'] },
      });
    // `none` is Pi's `off`; values Pi has no level for are dropped.
    expect(levels([{ type: 'effort', values: ['max', 'none', 'low', 'default', null] }])).toEqual([
      'off',
      'low',
      'max',
    ]);
    // A toggle adds `off` to the effort levels.
    expect(levels([{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }])).toEqual(['off', 'high', 'max']);
    // Pi turns these four levels into token budgets; a budget alone never means `off`.
    expect(levels([{ type: 'budget_tokens' }])).toEqual(['minimal', 'low', 'medium', 'high']);
    // Nothing to choose from: no options, an always-on model, a bare toggle, or
    // a model that does not reason at all.
    expect(levels(undefined)).toBeNull();
    expect(levels([])).toBeNull();
    expect(levels([{ type: 'toggle' }])).toBeNull();
    expect(levels([{ type: 'effort', values: ['none'] }])).toBeNull();
    expect(levels([{ type: 'effort', values: ['low'] }], false)).toBeNull();
  });
});

describe('provider wizard discovery', () => {
  test('appends models to the configured API root', () => {
    expect(planModelsEndpoint({ baseUrl: 'https://example.test/v1/', api: 'openai-responses' }).endpoint).toBe(
      'https://example.test/v1/models',
    );
    expect(() => assertBaseUrl('https://user@example.test/v1')).toThrow('without credentials');
    expect(() => assertBaseUrl('https://example.test/v1?tenant=a')).toThrow('query');
  });

  test('fetches, authenticates, validates, and deduplicates provider models', async () => {
    let observedPath = '';
    let observedAuthorization = '';
    let observedRoute = '';
    const server = await startFixtureServer((request) => {
      observedPath = new URL(request.url).pathname;
      observedAuthorization = request.headers.get('authorization') ?? '';
      observedRoute = request.headers.get('x-route') ?? '';
      if (observedPath === '/invalid/models') {
        return Response.json({ models: [] });
      }
      return Response.json({
        object: 'list',
        data: [
          { id: 'zeta', object: 'model' },
          { id: 'alpha', name: 'Alpha', object: 'model' },
          { id: 'zeta', object: 'model' },
        ],
      });
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const listing = await fetchProviderModels({
        baseUrl: `${baseUrl}/v1`,
        api: 'openai-responses',
        apiKey: 'provider-secret',
        headers: { 'x-route': 'route-secret' },
      });
      expect(observedPath).toBe('/v1/models');
      expect(observedAuthorization).toBe('Bearer provider-secret');
      expect(observedRoute).toBe('route-secret');
      expect(listing.endpoint).toBe(`${baseUrl}/v1/models`);
      expect(listing.models.map((model) => ({ id: model.id, name: model.name }))).toEqual([
        { id: 'alpha', name: 'Alpha' },
        { id: 'zeta', name: null },
      ]);

      await expect(
        fetchProviderModels({
          baseUrl: `${baseUrl}/invalid`,
          api: 'openai-completions',
          apiKey: 'provider-secret',
        }),
      ).rejects.toThrow('invalid OpenAI models response');
    } finally {
      await stopFixtureServer(server.server);
    }
  });
});

describe('configure CLI option', () => {
  test('parses the serve takeover option and rejects it elsewhere', () => {
    const options = parseCli(['serve', '--config', 'dev-data/config.jsonc', '--takeover']);
    expect(options.command).toBe('serve');
    expect(options.takeover).toBe(true);
    expect(() => parseCli(['doctor', '--config', 'dev-data/config.jsonc', '--takeover'])).toThrow();
  });
});

describe('configure thinking levels', () => {
  test('without an agent model every level stays selectable after one is chosen', async () => {
    const { configPath } = await fixture();
    const { fileConfig } = await loadConfig(configPath);
    fileConfig.agent = { thinking_level: 'low' };
    expect(agentThinkingLevels(fileConfig)).toEqual(THINKING_LEVELS);
  });
});
