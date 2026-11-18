import { expect, test } from 'vitest';
import { CHAT_ID, setup } from '../config/reload-fixtures.ts';
import type { FixtureConfig } from '../helpers.ts';
/**
 * A publish hook that fails after a rotation must not swallow the rotated
 * aliases: the retry apply passes the same alias to the hook again, so the
 * MCP cutover reconnects the server with the new value.
 */
test('a failed publish hook retries the rotated MCP alias on the next apply', async () => {
  const publications: string[][] = [];
  let failNextPublish = true;
  const fixture = await setup({
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
    onPublished: async ({ rotatedMcpAliases }) => {
      if (failNextPublish) {
        failNextPublish = false;
        throw new Error('Synthetic publish failure');
      }
      publications.push([...rotatedMcpAliases]);
    },
  });
  try {
    await fixture.reloader.keychainWrite({ add: { 'mcp-notes': 'notes-secret' } });
    const adopted = await fixture.reloader.reloadFromFile();
    expect(adopted.ok).toBe(true);
    // The rotation lands while the publish hook is primed to fail once: the
    // configuration is already published, but the hook failure is reported.
    const rotated = await fixture.reloader.keychainRotate('mcp-notes', 'notes-secret-v2');
    expect(rotated).toMatchObject({ ok: false, code: 'publish_incomplete' });
    // The retry apply passes the rotated alias to the hook again.
    const retried = await fixture.reloader.reloadFromFile();
    expect(retried.ok).toBe(true);
    expect(publications.at(-1)).toEqual(['notes']);
    void CHAT_ID;
  } finally {
    fixture.store.close();
  }
});
