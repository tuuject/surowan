/**
 * Skill discovery is an async step between `listTools` and publishing, so a
 * stop can land while it is still waiting on the server.
 *
 * Ways this can fail:
 * - the attempt resumes after the stop and publishes its skills, error code,
 *   tools or `ready` state into the stopped alias;
 * - discovery ignores the attempt's abort, so `stop()` waits out the request
 *   timeout (or never returns) and the stdio child outlives the manager.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import type { McpServerConfig, RawConfig } from '../../src/platform/config/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { fixture } from '../admin/fixtures.ts';

const SKILLS_SERVER = join(import.meta.dirname, '..', 'fixtures', 'mcp-skills-server.ts');

test('a stop while skill discovery waits on the server publishes nothing and returns promptly', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-skills-race-'));
  const marker = join(directory, 'reading');
  const server = {
    alias: 'sk',
    transport: 'stdio',
    command: [process.execPath, SKILLS_SERVER, 'hang', marker],
    tools: '*',
    payload_max_bytes: 1_048_576,
    result_max_bytes: 32_768,
    default_tool_policy: { read_only: true, timeout_seconds: 10 },
  } as McpServerConfig;
  const config: RawConfig = { ...f.loaded.config, mcp: { servers: [server] } };
  const manager = new McpManager(f.store, config, new SecretStore());
  onTestFinished(async () => {
    await manager.stop();
    await f.server.stop();
    f.store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  manager.setRegistryValidator(() => {});
  await manager.start();

  await vi.waitFor(
    () => {
      if (!existsSync(marker)) {
        throw new Error('discovery has not reached resources/read yet');
      }
    },
    { timeout: 20_000, interval: 50 },
  );
  expect(manager.serverStates()).toMatchObject([{ alias: 'sk', state: 'starting' }]);

  const startedAt = performance.now();
  await manager.stop();
  // Well under the 10 s per-request timeout: the abort reached the pending read.
  expect(performance.now() - startedAt).toBeLessThan(5_000);

  expect(manager.serverStates()).toMatchObject([{ alias: 'sk', state: 'stopped' }]);
  expect(manager.serverToolListings()).toEqual([
    { alias: 'sk', tools: [], instructions: null, skills: [], skills_error: null },
  ]);
  const row = f.store.db
    .prepare<[], { state: string; registry_hash: string | null }>(
      "SELECT state, registry_hash FROM mcp_server_state WHERE alias = 'sk'",
    )
    .get();
  expect(row).toEqual({ state: 'stopped', registry_hash: null });
}, 60_000);
