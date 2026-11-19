/**
 * The MCP servers page's presentation fields: `exposure`, `description`, and
 * the tool-model description draft.
 *
 * Ways these could fail: a description-only edit through the CLI or MCP
 * (`--set description=...`) wipes the tool list or limits it did not send; a
 * blank description lands in the file; `direct` is written out instead of
 * dropping back to the default; the draft writes the file, reads tools the
 * server's selection hides, runs without a connected server, or runs for a
 * key without the paid permission; and the standing warning misses a
 * progressive server that has no description.
 */
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { bearerKey, httpServer, mcpAdminFixture, write } from './mcp-servers-fixtures.ts';

type ServerFile = Record<string, unknown> & { readonly alias: string };

function serverIn(file: { readonly mcp?: { readonly servers: readonly unknown[] } }, alias: string): ServerFile {
  const found = (file.mcp?.servers ?? []).find((entry) => (entry as ServerFile).alias === alias);
  if (found === undefined) {
    throw new Error(`${alias} is missing from the file`);
  }
  return found as ServerFile;
}

test('exposure and description travel alone, keep every other field, and drive the standing warning', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const before = serverIn(fixture.file(), 'stdio-fixture');
    const set = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', {
      exposure: 'progressive',
      description: '  Echo tools for tests.  ',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const after = serverIn(fixture.file(), 'stdio-fixture');
    expect(after).toEqual({ ...before, exposure: 'progressive', description: 'Echo tools for tests.' });
    // Hot-applied, and the view reports both fields.
    expect(fixture.runtime().mcp?.servers.find((server) => server.alias === 'stdio-fixture')).toMatchObject({
      exposure: 'progressive',
      description: 'Echo tools for tests.',
    });
    const view = (await write(fixture, '/mcp-servers', 'GET', undefined)).body as {
      readonly servers?: readonly {
        readonly alias: string;
        readonly exposure?: string;
        readonly description?: unknown;
      }[];
    };
    expect(view.servers?.find((server) => server.alias === 'stdio-fixture')).toMatchObject({
      exposure: 'progressive',
      description: 'Echo tools for tests.',
    });
    expect(view.servers?.find((server) => server.alias === 'http-remote')).toMatchObject({
      exposure: 'direct',
      description: null,
    });

    const warnings = async () =>
      (
        (await (
          await fixture.server.handle(
            new Request('http://127.0.0.1:8899/api/warnings', { headers: { cookie: fixture.cookie } }),
          )
        ).json()) as { readonly standing: readonly { readonly code: string; readonly variables: unknown }[] }
      ).standing.filter((warning) => warning.code === 'mcp_description_missing');
    expect(await warnings()).toEqual([]);

    // A blank description is a removal, never a blank field in the file.
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { description: '   ' })).status).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).not.toHaveProperty('description');
    expect(await warnings()).toEqual([
      expect.objectContaining({ code: 'mcp_description_missing', variables: { aliases: ['stdio-fixture'] } }),
    ]);

    // `direct` is the default, so choosing it drops the field.
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { exposure: 'direct' })).status).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).toEqual(before);
    expect(await warnings()).toEqual([]);

    // An empty string is one more spelling of "no description".
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { description: 'set' })).status).toBe(200);
    expect((await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { description: '' })).status).toBe(200);
    expect(serverIn(fixture.file(), 'stdio-fixture')).toEqual(before);

    // A presentation-only edit of an HTTP server keeps its URL and headers as stored.
    const httpBefore = serverIn(fixture.file(), 'http-remote');
    expect((await write(fixture, '/mcp-servers/http-remote', 'PUT', { description: 'Remote tools.' })).status).toBe(
      200,
    );
    expect(serverIn(fixture.file(), 'http-remote')).toEqual({ ...httpBefore, description: 'Remote tools.' });

    const tooLong = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', { description: 'x'.repeat(1_001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('invalid_body');
    expect(serverIn(fixture.file(), 'stdio-fixture')).toEqual(before);

    const created = await write(fixture, '/mcp-servers', 'POST', {
      ...httpServer,
      exposure: 'progressive',
      description: 'Remote search tools.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(serverIn(fixture.file(), 'added-http')).toMatchObject({
      exposure: 'progressive',
      description: 'Remote search tools.',
    });
  } finally {
    await fixture.manager?.stop();
    fixture.store.close();
  }
});

test('the description draft reads only exposed tools, writes nothing, and needs the paid permission', async () => {
  const faux = fauxProvider({
    provider: 'agent',
    models: [
      { id: 'agent-model', reasoning: true, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const fixture = await mcpAdminFixture({ manager: true, registry: { models, visionModel: faux.getModel() } });
  try {
    await fixture.settled();
    const draft = (alias: string, headers: Record<string, string> = { cookie: fixture.cookie }) =>
      fixture.server.handle(
        new Request(`http://127.0.0.1:8899/api/mcp-servers/${alias}/description-draft`, {
          method: 'POST',
          headers,
        }),
      );
    const before = await fixture.read();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('{"description":" Echoes text back, for testing. "}');
      },
    ]);
    const response = await draft('stdio-fixture');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alias: 'stdio-fixture',
      description: 'Echoes text back, for testing.',
      tool_model: { provider: 'agent', model: 'agent-model' },
    });
    // The server's selection is `echo` only: hidden tools never reach the prompt.
    expect(prompts[0]).toContain('Echo text with a server-side call count');
    expect(prompts[0]).not.toContain('Answer only after the given delay');
    // A draft is not a write, and its billed call is audited.
    expect(await fixture.read()).toBe(before);
    expect(
      fixture.store.db
        .prepare<[], { role: string; state: string }>('SELECT role, state FROM model_calls ORDER BY id')
        .all(),
    ).toEqual([{ role: 'tool', state: 'success' }]);

    // A known secret never travels back, even when the model repeats one (the
    // HTTP fixture's header value is known once its connection resolved it).
    faux.setResponses([fauxAssistantMessage('{"description":"Calls with mcp-header-secret attached."}')]);
    const leaked = (await (await draft('stdio-fixture')).json()) as { description: string };
    expect(leaked.description).not.toContain('mcp-header-secret');

    // An unusable reply is an error, audited as such; the caller gets a
    // message, never a stack with local paths.
    faux.setResponses([fauxAssistantMessage('no json here')]);
    const invalid = await draft('stdio-fixture');
    expect(invalid.status).toBe(502);
    const invalidBody = (await invalid.json()) as { error: string; message: string };
    expect(invalidBody.error).toBe('tool_model_unavailable');
    expect(invalidBody.message).not.toMatch(/\n\s+at /);
    expect(
      fixture.store.db
        .prepare<[], { error_code: string | null }>('SELECT error_code FROM model_calls ORDER BY id DESC LIMIT 1')
        .get(),
    ).toEqual({ error_code: 'tool_model_invalid_output' });

    // The unreachable HTTP fixture never advertised anything to describe.
    const notReady = await draft('http-remote');
    expect(notReady.status).toBe(409);
    expect(((await notReady.json()) as { error: string }).error).toBe('mcp_server_not_ready');
    expect((await draft('missing')).status).toBe(404);

    // Saved but not running yet: the live tools belong to the server it replaces.
    const file = fixture.file();
    const edited = {
      ...file,
      mcp: {
        servers: (file.mcp?.servers ?? []).map((entry) =>
          (entry as ServerFile).alias === 'stdio-fixture' ? { ...entry, payload_max_bytes: 4_096 } : entry,
        ),
      },
    };
    await writeFile(fixture.configPath, JSON.stringify(edited, null, 2));
    const notApplied = await draft('stdio-fixture');
    expect(notApplied.status).toBe(409);
    expect(((await notApplied.json()) as { error: string }).error).toBe('mcp_server_not_applied');

    // A key without the paid permission cannot spend tool-model tokens.
    const writeOnly = await draft('stdio-fixture', await bearerKey(fixture, 'read_write'));
    expect(writeOnly.status).toBe(403);
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()?.count,
    ).toBe(3n);
  } finally {
    await fixture.manager?.stop();
    fixture.store.close();
  }
});
