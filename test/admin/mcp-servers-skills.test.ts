/**
 * The MCP servers page's `skills` switch (whether the model may read the skills
 * a server publishes).
 *
 * Ways this could fail: the switch cannot be written alone, or a switch-only
 * edit wipes the tools or limits it did not send; `true` (the default) is
 * written out instead of dropping the field; a non-boolean is accepted; the
 * running configuration or the view does not follow the file; a create ignores
 * it.
 */
import { expect, test } from 'vitest';
import { httpServer, mcpAdminFixture, write } from './mcp-servers-fixtures.ts';

type ServerFile = Record<string, unknown> & { readonly alias: string };

function serverIn(file: { readonly mcp?: { readonly servers: readonly unknown[] } }, alias: string): ServerFile {
  const found = (file.mcp?.servers ?? []).find((entry) => (entry as ServerFile).alias === alias);
  if (found === undefined) {
    throw new Error(`${alias} is missing from the file`);
  }
  return found as ServerFile;
}

test('skills travels alone, drops back to the default, and the view and runtime follow', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const before = serverIn(fixture.file(), 'stdio-fixture');
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { skills: false })).status).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).toEqual({ ...before, skills: false });
    expect(fixture.runtime().mcp?.servers.find((server) => server.alias === 'stdio-fixture')).toMatchObject({
      skills: false,
    });
    const view = (await write(fixture, '/mcp-servers', 'GET', undefined)).body as {
      readonly servers?: readonly {
        readonly alias: string;
        readonly skills_enabled?: boolean;
        readonly skills?: unknown;
      }[];
    };
    expect(view.servers?.find((server) => server.alias === 'stdio-fixture')).toMatchObject({
      skills_enabled: false,
      skills: [],
    });
    expect(view.servers?.find((server) => server.alias === 'http-remote')).toMatchObject({ skills_enabled: true });

    // An unrelated edit keeps the switch; `true` is the default, so the field goes away.
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { exposure: 'progressive' })).status).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).toMatchObject({ skills: false, exposure: 'progressive' });
    expect(
      (await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { skills: true, exposure: 'direct' })).status,
    ).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).toEqual(before);

    const invalid = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { skills: 'no' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('invalid_body');

    const created = await write(fixture, '/mcp-servers', 'POST', { ...httpServer, skills: false });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(serverIn(fixture.file(), 'added-http')).toMatchObject({ skills: false });
  } finally {
    await fixture.manager?.stop();
    fixture.store.close();
  }
});
