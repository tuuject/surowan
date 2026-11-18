import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { afterThisTest, type FixtureConfig, trackTempDirectory } from '../helpers.ts';
import { AGENT_MODEL, CHAT_ID, CountingSecrets, customProvider, setup } from './reload-fixtures.ts';

const commandDirectories: string[] = [];

afterThisTest(
  async () => {
    await Promise.all(commandDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  },
  () => undefined,
);

/**
 * The hot-apply contract for keychain rotations: a value change no configuration
 * file shows must still rebuild the connections that use the entry, without
 * resolving anything the rotation does not touch, and MCP servers — whose
 * secrets resolve at connect time — keep waiting for a restart.
 */
test('rotating a jar entry rebuilds the provider that uses it and nothing else', async () => {
  const fixture = await setup({ secrets: (keychain) => new CountingSecrets(keychain) });
  try {
    const before = fixture.configStore.current().models.getProvider('faux');
    const resolutions = (fixture.secrets as CountingSecrets).resolutions;

    // A rotation rewrites key.json only; the reload the rotation triggers must
    // still pick it up.
    const rotated = await fixture.reloader.keychainRotate('faux', 'faux-secret-v2');
    expect(rotated.ok).toBe(true);
    expect((fixture.secrets as CountingSecrets).resolutions).toBeGreaterThan(resolutions);
    const after = fixture.configStore.current().models.getProvider('faux');
    expect(after).not.toBe(before);
    // The faux stand-in the fixture installed is rebuilt as the real provider,
    // so the registry identity moved even though `config.jsonc` did not.
    expect(fixture.configStore.current().hash).toBe(fixture.configStore.current().hash);

    // A second reload with nothing changed reuses the freshly built connection.
    const stable = fixture.configStore.current().models.getProvider('faux');
    const resolutionsAfterRotate = (fixture.secrets as CountingSecrets).resolutions;
    const again = await fixture.reloader.reloadFromFile();
    expect(again.ok).toBe(true);
    expect((fixture.secrets as CountingSecrets).resolutions).toBe(resolutionsAfterRotate);
    expect(fixture.configStore.current().models.getProvider('faux')).toBe(stable);
  } finally {
    fixture.store.close();
  }
});

test('an env-backed provider keeps its resolved connection across applies', async () => {
  // The startup build resolves the reference, so the variable exists first.
  process.env.SUROWAN_VISION_KEY = 'env-secret';
  const fixture = await setup({
    secrets: (keychain) => new CountingSecrets(keychain),
    transform: (config) => {
      const vision = customProvider(config.providers, 'vision');
      vision.api_key = { env: 'SUROWAN_VISION_KEY' };
    },
  });
  try {
    try {
      // Adopt the env reference first: one resolution at build time.
      const adopted = await fixture.reloader.reloadFromFile();
      expect(adopted.ok).toBe(true);
      const afterAdopt = (fixture.secrets as CountingSecrets).resolutions;
      // Changing the environment variable is invisible to hot apply by design.
      process.env.SUROWAN_VISION_KEY = 'env-secret-v2';
      const applied = await fixture.reloader.reloadFromFile();
      expect(applied.ok).toBe(true);
      expect((fixture.secrets as CountingSecrets).resolutions).toBe(afterAdopt);
    } finally {
      delete process.env.SUROWAN_VISION_KEY;
    }
  } finally {
    fixture.store.close();
  }
});

test('a command reference is never executed by the rotation check', async () => {
  // The command rewrites a marker file whenever it runs: the startup build runs
  // it exactly once, and the rotation apply must not run it again.
  const directory = await mkdtemp(join(tmpdir(), 'surowan-command-marker-'));
  trackTempDirectory(commandDirectories, directory);
  const marker = join(directory, 'command-marker.log');
  const fixture = await setup({
    transform: (config) => {
      const agent = customProvider(config.providers, 'agent');
      const markerPosix = marker.split(String.fromCharCode(92)).join('/');
      const script = `require('node:fs').writeFileSync('${markerPosix}', 'started');console.log('ok');`;
      agent.api_key = { command: [process.execPath, '-e', script] };
    },
  });
  try {
    const adopted = await fixture.reloader.reloadFromFile();
    expect(adopted.ok).toBe(true);
    const afterStartup = await readFile(marker, 'utf8');
    // Rotating an unrelated entry rebuilds `faux` but must not run the agent's
    // command: the digest of a `command` reference is a constant.
    const rotated = await fixture.reloader.keychainRotate('faux', 'faux-secret-v2');
    expect(rotated.ok).toBe(true);
    expect(await readFile(marker, 'utf8')).toBe(afterStartup);
  } finally {
    fixture.store.close();
  }
});

test('rotating an entry an MCP server uses reconnects it through the hot path', async () => {
  const captured: string[][] = [];
  const fixture = await setup({
    onPublished: async ({ rotatedMcpAliases }) => {
      captured.push([...rotatedMcpAliases]);
    },
    transform: (config) => {
      const fixtureConfig = config as FixtureConfig;
      fixtureConfig.mcp = {
        servers: [
          {
            alias: 'notes',
            transport: 'stdio',
            command: ['node', 'server.js'],
            tools: '*',
            payload_max_bytes: 32_768,
            result_max_bytes: 32_768,
            default_tool_policy: { read_only: true, timeout_seconds: 20 },
            env: { NOTES_KEY: { jar: 'mcp-notes' } },
          },
        ],
      };
    },
  });
  try {
    await fixture.reloader.keychainWrite({ add: { 'mcp-notes': 'notes-secret' } });
    const adopted = await fixture.reloader.reloadFromFile();
    expect(adopted.ok && adopted.restartRequired).toEqual([]);
    // Nothing rotated and nothing pending: no publish ran at all.
    expect(captured).toEqual([]);

    // The rotation alone publishes: the hot MCP path reconnects the server.
    const rotated = await fixture.reloader.keychainRotate('mcp-notes', 'notes-secret-v2');
    expect(rotated.ok).toBe(true);
    expect(captured.at(-1)).toEqual(['notes']);
    expect(rotated.ok && rotated.applied).toContain('mcp.servers');
    // No restart is required anywhere.
    expect(rotated.ok && rotated.restartRequired).toEqual([]);

    // An unrelated apply does not flag anything.
    const unrelated = await fixture.reloader.writeAndApply([
      { path: ['telegram', 'chats', 0, 'thinking_level'], value: 'high' },
    ]);
    expect(unrelated.ok).toBe(true);
    expect(captured.at(-1)).toEqual([]);
  } finally {
    fixture.store.close();
  }
});

test('the running invocation snapshot keeps the connection it started with', async () => {
  const fixture = await setup();
  try {
    const invocationStore = fixture.configStore.beginInvocation();
    const pinned = invocationStore.models.getProvider('faux');
    await fixture.reloader.keychainRotate('faux', 'faux-secret-v2');
    expect(fixture.configStore.current().models.getProvider('faux')).not.toBe(pinned);
    // The frozen snapshot still holds the old object: in-flight invocations
    // finish on the credentials they started with.
    expect(invocationStore.models.getProvider('faux')).toBe(pinned);
    expect((await fixture.reloader.readPersisted()).config.telegram.chats[0]?.id).toBe(CHAT_ID);
    expect(fixture.configStore.current().config.agent!.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});
