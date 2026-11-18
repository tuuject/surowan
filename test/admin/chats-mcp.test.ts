import { expect, test } from 'vitest';
import { mcpAdminFixture, revisionOf, type McpAdminFixture } from './mcp-servers-fixtures.ts';
import type { FileChat } from '../../src/platform/config/index.ts';

async function putMcp(
  fixture: McpAdminFixture,
  chatId: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fixture.server.handle(
    new Request(`http://127.0.0.1:8899/api/chats/${chatId}/mcp`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-match': await revisionOf(fixture),
        cookie: fixture.cookie,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function chatOf(fixture: McpAdminFixture, id: number): FileChat | undefined {
  return fixture.file().telegram.chats.find((chat) => chat.id === id);
}

test('a Chat binding cycles through inherit, none and explicit shapes on disk', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const chat = '123456789';
    expect(chatOf(fixture, 123_456_789)?.mcp).toBeUndefined();

    const none = await putMcp(fixture, chat, { mode: 'none' });
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(chatOf(fixture, 123_456_789)?.mcp).toEqual([]);

    const explicit = await putMcp(fixture, chat, {
      mode: 'explicit',
      bindings: [
        { server: 'stdio-fixture', tools: ['echo'] },
        { server: 'http-remote', tool_policies: [{ name: 'anything', read_only: true, timeout_seconds: 5 }] },
      ],
    });
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);
    expect(chatOf(fixture, 123_456_789)?.mcp).toEqual([
      { server: 'stdio-fixture', tools: ['echo'] },
      { server: 'http-remote', tool_policies: [{ name: 'anything', read_only: true, timeout_seconds: 5 }] },
    ]);
    // Applied, not just written: the running configuration carries the binding.
    expect(fixture.runtime().telegram.chats.find((chat) => chat.id === 123_456_789)?.mcp).toEqual([
      { server: 'stdio-fixture', tools: ['echo'] },
      { server: 'http-remote', tool_policies: [{ name: 'anything', read_only: true, timeout_seconds: 5 }] },
    ]);

    const inherit = await putMcp(fixture, chat, { mode: 'inherit' });
    expect(inherit.status, JSON.stringify(inherit.body)).toBe(200);
    expect(chatOf(fixture, 123_456_789)?.mcp).toBeUndefined();

    // Saving the same value again leaves the file alone.
    const before = await fixture.read();
    const repeat = await putMcp(fixture, chat, { mode: 'inherit' });
    expect(repeat.status).toBe(200);
    expect(await fixture.read()).toBe(before);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('unknown aliases and tools outside the server list are refused before the file changes', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const before = await fixture.read();
    const unknownServer = await putMcp(fixture, '-100777', {
      mode: 'explicit',
      bindings: [{ server: 'no-such-server' }],
    });
    expect(unknownServer.status).toBe(400);
    expect(unknownServer.body).toMatchObject({ error: 'mcp_invalid' });
    expect(unknownServer.body.message).toContain('unknown server no-such-server');

    const outsideList = await putMcp(fixture, '-100777', {
      mode: 'explicit',
      bindings: [{ server: 'stdio-fixture', tools: ['wait'] }],
    });
    expect(outsideList.status).toBe(400);
    expect(outsideList.body).toMatchObject({ error: 'mcp_invalid' });
    expect(outsideList.body.message).toContain('wait');

    const unconfiguredChat = await putMcp(fixture, '-999999', { mode: 'none' });
    expect(unconfiguredChat.status).toBe(404);
    expect(unconfiguredChat.body).toMatchObject({ error: 'chat_not_found' });

    expect(await fixture.read()).toBe(before);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('binding writes validate against the deployment registered search providers', async () => {
  const fixture = await mcpAdminFixture({ customSearch: true });
  try {
    const bound = await putMcp(fixture, '-100777', {
      mode: 'explicit',
      bindings: [{ server: 'stdio-fixture', tools: ['echo'] }],
    });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(chatOf(fixture, -100_777)?.mcp).toEqual([{ server: 'stdio-fixture', tools: ['echo'] }]);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});
