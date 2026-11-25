import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ParseError, parse } from 'jsonc-parser';
import { afterAll, expect, test } from 'vitest';
import { renderConfigFieldPages } from '../../scripts/docs/config-fields/index.ts';
import { isGeneratedPage } from '../../scripts/docs/generated-pages.ts';
import { docsLocales } from '../../scripts/docs/locales.ts';
import { deploymentSettings, docsRoot } from '../../scripts/docs/prepare.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { plaintextSecrets } from '../../src/platform/config/validate.ts';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

function parseExample(text: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(text, errors, { allowTrailingComma: true });
  expect(errors).toEqual([]);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) {
    return patch;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = merge(base[key], value);
  }
  return result;
}

async function fixture(): Promise<{ directory: string; configPath: string; baseline: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-docs-'));
  directories.push(directory);
  await copyFile(resolve(docsRoot, 'examples/system-prompt.example.md'), join(directory, 'system-prompt.md'));
  await mkdir(join(directory, 'prompts'));
  for (const name of ['system', 'group', 'social']) {
    await writeFile(join(directory, `prompts/${name}.md`), 'Synthetic documentation test prompt.');
  }
  return {
    directory,
    configPath: join(directory, 'config.jsonc'),
    baseline: parseExample(await readFile(resolve(docsRoot, 'examples/config.example.jsonc'), 'utf8')),
  };
}

test('public full example passes the real loader without resolving credentials or contacting services', async () => {
  const { configPath, baseline } = await fixture();
  expect(plaintextSecrets(baseline)).toEqual([]);
  await writeFile(configPath, JSON.stringify(baseline));
  const loaded = await loadConfig(configPath);
  expect(loaded.config.telegram.token).toEqual({ env: 'TELEGRAM_BOT_TOKEN' });
  expect(loaded.config.agent!.system_prompt).not.toBe('');
  expect(loaded.config.vision.model).toBe(loaded.config.agent!.model);
  expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
});

test('minimal example starts a panel-only deployment on its own, before any provider exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-docs-minimal-'));
  directories.push(directory);
  const source = await readFile(resolve(docsRoot, 'examples/config.minimal.example.jsonc'), 'utf8');
  const config = parseExample(source);
  expect(plaintextSecrets(config)).toEqual([]);
  const configPath = join(directory, 'config.jsonc');
  await writeFile(configPath, source);
  const loaded = await loadConfig(configPath);
  // No Telegram section at all: the panel and Playground still start.
  expect(loaded.config.telegram.token).toBeUndefined();
  expect(loaded.config.telegram.chats).toEqual([]);
  expect(loaded.config.admin.enabled).toBe(true);
  // Models and prompts are added in the panel; the file itself is valid without them.
  expect(Object.keys(loaded.config.providers)).toEqual([]);
  expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
});

test('every hand-written JSONC fragment in either locale merges into the public baseline', async () => {
  const { configPath, baseline } = await fixture();
  for (const lang of docsLocales) {
    const root = resolve(docsRoot, 'content', lang, 'docs');
    const pages = (await readdir(root, { recursive: true })).filter(
      (path) => path.endsWith('.md') && !isGeneratedPage(path.replaceAll('\\', '/')),
    );
    for (const page of pages) {
      const text = await readFile(join(root, page), 'utf8');
      for (const match of text.matchAll(/```jsonc\r?\n([\s\S]*?)\r?\n```/g)) {
        const combined = merge(baseline, parseExample(match[1] ?? ''));
        expect(plaintextSecrets(combined), `${lang}/${page}`).toEqual([]);
        await writeFile(configPath, JSON.stringify(combined));
        await expect(loadConfig(configPath), `${lang}/${page}`).resolves.toHaveProperty('hash');
      }
    }
  }
});

test('schema reference covers nested arrays, union policies and required/optional distinctions in both locales', () => {
  const zh = [...renderConfigFieldPages('zh').values()].join('\n');
  const en = [...renderConfigFieldPages('en').values()].join('\n');
  for (const fields of [zh, en]) {
    for (const name of [
      'telegram.chats[].topic_ids',
      'tool_policies[].name',
      'retention.online_days',
      'web_fetch',
      'developer.record_model_payloads',
      'developer.record_agent_thinking',
    ]) {
      expect(fields).toContain(name);
    }
    expect(fields).toContain('exclusiveMinimum');
    expect(fields).not.toContain('undefined');
  }
  expect(zh).toContain('agent（分支 1）.context.ref_ttl_hours');
  expect(en).toContain('agent (branch 1).context.ref_ttl_hours');
  expect(zh).toContain('可选不等于有默认值');
  expect(en).toContain('Optional does not mean');
  // Both locales publish the same configuration sections.
  expect([...renderConfigFieldPages('zh').keys()]).toEqual([...renderConfigFieldPages('en').keys()]);
});

test('deployment URL settings reject credentials and malformed base paths', () => {
  expect(deploymentSettings({})).toEqual({ siteOrigin: '', base: '/' });
  expect(deploymentSettings({ DOCS_SITE_ORIGIN: 'https://docs.example.com', DOCS_BASE_PATH: '/surowan/' })).toEqual({
    siteOrigin: 'https://docs.example.com',
    base: '/surowan/',
  });
  for (const origin of [
    'https://user:pass@docs.example.com',
    'https://docs.example.com/a',
    'https://docs.example.com?key=example',
    'file:///tmp',
    'not-a-url',
  ]) {
    expect(() => deploymentSettings({ DOCS_SITE_ORIGIN: origin })).toThrow();
  }
  for (const base of ['relative/', '/no-trailing-slash', '//', '/../', '/a?b/']) {
    expect(() => deploymentSettings({ DOCS_BASE_PATH: base })).toThrow();
  }
});
