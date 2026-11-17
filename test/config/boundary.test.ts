import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { AgentSectionConfig } from '../../src/platform/config/index.ts';
import { resolveAgentSection } from '../../src/platform/config/resolve.ts';

import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { validateFileConfig } from '../../src/platform/config/validate.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'surowan-config-boundary-'));
  dirs.push(dir);
  const configPath = join(dir, 'config.jsonc');
  await writeTestConfig(dir, configPath, testConfigJsonc(dir));
  return { dir, configPath };
}

test('source-free validation agrees with the local file loader', async () => {
  const { configPath } = await fixture();
  const text = await readFile(configPath, 'utf8');
  const parsed: unknown = parse(text);
  const validated = validateFileConfig(parsed);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig).toEqual(validated.fileConfig);
  expect(loaded.warnings).toEqual(validated.warnings);
  expect(loaded.hash).toBe(
    createHash('sha256')
      .update(text)
      .update(`\u0000${await readFile(join(configPath, '..', 'agent-system-prompt.md'), 'utf8')}`)
      .update(`\u0000${await readFile(join(configPath, '..', 'chat-instructions.md'), 'utf8')}`)
      .digest('hex'),
  );
});

test('schema and secret checks do not require file access', () => {
  const parsed: unknown = parse(testConfigJsonc('/nonexistent-config-directory'));
  const root = parsed as Record<string, any>;
  root.agent.system_prompt_file = 'does-not-exist.md';
  expect(validateFileConfig(parsed).fileConfig).toBe(parsed);
  root.agent.system_prompt_file = 42;
  expect(() => validateFileConfig(parsed)).toThrow(/Invalid config/);
  root.agent.system_prompt_file = 'does-not-exist.md';
  root.telegram.token = 'secret';
  expect(() => validateFileConfig(parsed)).toThrow(/plaintext secrets are not accepted/);
});

test('empty-text strategy defaults to reject and ignores the retired fallback flag', () => {
  expect(resolveAgentSection(undefined).send_empty_text_strategy).toBe('reject');
  expect(resolveAgentSection({ send_empty_text_strategy: 'silent_success' }).send_empty_text_strategy).toBe(
    'silent_success',
  );
  // The flag no longer derives a strategy; it is rejected by the schema, and
  // anything that reaches resolution untyped stays inert.
  expect(
    resolveAgentSection({ send_empty_text_fallback_enabled: true } as AgentSectionConfig).send_empty_text_strategy,
  ).toBe('reject');
});

test.each<[string, string, unknown]>([
  ['agent', 'memory_ttl_warning_days', 30],
  ['agent', 'send_empty_text_fallback_enabled', true],
  ['vision', 'background_sticker_concurrency', 1],
])('a leftover %s.%s key is rejected with the key named in the error', async (section, key, value) => {
  const { dir, configPath } = await fixture();
  const jsonc = testConfigJsonc(dir, (config) => {
    (config as unknown as Record<string, Record<string, unknown>>)[section]![key] = value;
  });
  await writeFile(configPath, jsonc, { mode: 0o600 });
  await expect(loadConfig(configPath)).rejects.toThrow(new RegExp(`/${section}.*${key}`));
});

test('invalid optional image is removed before file prompt loading', async () => {
  const { dir, configPath } = await fixture();
  const jsonc = testConfigJsonc(dir, (config) => {
    (config as Record<string, unknown>).image = { models: 'invalid' };
  });
  await writeFile(configPath, jsonc, { mode: 0o600 });
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.image).toBeUndefined();
  expect(loaded.warnings).toHaveLength(1);
  expect(loaded.warnings[0]).toContain('image generation disabled');
});
