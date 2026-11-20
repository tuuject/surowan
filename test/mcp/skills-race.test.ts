/**
 * Skill discovery is an async step between `listTools` and publishing, so the
 * server, a stop or a notification can land while it is still waiting.
 *
 * Ways this can fail:
 * - a stop lands mid-discovery and the attempt resumes, publishing its skills,
 *   error code, tools or `ready` state into the stopped alias;
 * - discovery ignores the attempt's abort, so `stop()` waits out the request
 *   timeout (or never returns) and the stdio child outlives the manager;
 * - the transport dies mid-discovery, discovery swallows the failed reads, and
 *   the dead client is published as `ready` — with the backoff reset on every
 *   publish, so the alias flaps at the shortest retry forever;
 * - `tools/list_changed` arrives before the attempt publishes, the refresh
 *   finds no client, and a healthy server is reported degraded and reconnected
 *   instead of re-listing its tools.
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

/** Starts one manager on the skills fixture in `mode` without waiting for its first attempt. */
async function startSkillsServer(mode: string, args: readonly string[] = []) {
  const f = await fixture();
  const events: string[] = [];
  const server = {
    alias: 'sk',
    transport: 'stdio',
    command: [process.execPath, SKILLS_SERVER, mode, ...args],
    tools: '*',
    payload_max_bytes: 1_048_576,
    result_max_bytes: 32_768,
    default_tool_policy: { read_only: true, timeout_seconds: 10 },
  } as McpServerConfig;
  const config: RawConfig = { ...f.loaded.config, mcp: { servers: [server] } };
  const manager = new McpManager(f.store, config, new SecretStore(), (event) => {
    events.push(event);
  });
  onTestFinished(async () => {
    await manager.stop();
    await f.server.stop();
    f.store.close();
  });
  manager.setRegistryValidator(() => {});
  await manager.start();
  const row = () =>
    f.store.db
      .prepare<[], { state: string; registry_hash: string | null; reconnect_attempt: bigint }>(
        "SELECT state, registry_hash, reconnect_attempt FROM mcp_server_state WHERE alias = 'sk'",
      )
      .get();
  return { manager, events, row };
}

test('a stop while skill discovery waits on the server publishes nothing and returns promptly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-skills-race-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const marker = join(directory, 'reading');
  const { manager, row } = await startSkillsServer('hang', [marker]);

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
  expect(row()).toMatchObject({ state: 'stopped', registry_hash: null });
}, 60_000);

test('a transport that dies during skill discovery fails the attempt instead of publishing ready', async () => {
  const { manager, row } = await startSkillsServer('die');

  // The caller's failure code only appears when the attempt throws; a published
  // dead client would sit at `ready` with no code instead.
  await vi.waitFor(
    () => {
      expect(manager.serverStates()).toMatchObject([
        { alias: 'sk', state: 'degraded', error_code: 'initialization_failed' },
      ]);
    },
    { timeout: 20_000, interval: 20 },
  );
  expect(manager.serverToolListings()).toEqual([
    { alias: 'sk', tools: [], instructions: null, skills: [], skills_error: null },
  ]);
  // `ready` writes the registry hash, and later states keep it: null proves the
  // alias never persisted `ready`. The retry counter was not reset by a publish.
  const persisted = row();
  expect(persisted).toMatchObject({ state: 'degraded', registry_hash: null });
  expect(persisted?.reconnect_attempt).toBeGreaterThanOrEqual(1n);
}, 60_000);

test('tools/list_changed during skill discovery is replayed after publish, not reported as an outage', async () => {
  const { manager, events, row } = await startSkillsServer('notify');

  // The tool the server added mid-discovery shows up through the replayed refresh.
  await vi.waitFor(
    () => {
      expect(manager.serverToolListings()[0]?.tools.map((tool) => tool.name)).toEqual(['ping', 'pong']);
    },
    { timeout: 20_000, interval: 50 },
  );
  expect(manager.serverStates()).toMatchObject([
    { alias: 'sk', state: 'ready', error_code: null, next_reconnect_at: null, retrying: false },
  ]);
  expect(manager.serverToolListings()[0]?.skills.map((skill) => skill.name)).toEqual(['demo', 'second']);
  expect(events).not.toContain('mcp_server_degraded');
  expect(row()).toMatchObject({ state: 'ready', reconnect_attempt: 0n });
}, 60_000);
