import { expect, test } from 'vitest';
import type { McpServerView } from '../../lib/api/mcp-servers.ts';
import { connectionChanged, draftOf, serverPayload } from './draft.ts';

/**
 * The server editor's draft round trips: what the form initializes from a view
 * row must survive an open-save cycle unchanged, and the boundary rules
 * (wildcard overrides kept, empty explicit lists allowed) must hold.
 */

function view(overrides: Partial<McpServerView>): McpServerView {
  return {
    alias: 'http-remote',
    transport: 'streamable_http',
    state: null,
    connection: { kind: 'streamable_http', url: 'https://mcp.example.test/mcp', headers: [] },
    tools: '*',
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    tool_policies: null,
    default_tool_policy: { read_only: true, timeout_seconds: 30 },
    advertised_tools: [],
    bound_chats: [],
    exposure: 'direct',
    description: null,
    skills_enabled: true,
    skills: [],
    skills_error: null,
    ...overrides,
  } as McpServerView;
}

test('an unchanged wildcard server keeps its per-tool overrides', () => {
  const server = view({
    tools: '*',
    default_tool_policy: { read_only: false, timeout_seconds: 30 },
    tool_policies: [{ name: 'query', read_only: true, timeout_seconds: 5 }],
  });
  const draft = draftOf(server);
  // The rows the form shows are the overrides themselves, so an operator who
  // only touches the URL or a limit still submits them.
  expect(draft.tools.map((tool) => tool.name)).toEqual(['query']);
  expect(draft.defaultReadOnly).toBe(false);

  const payload = serverPayload(draft);
  expect(payload.error).toBeNull();
  expect(payload.body).toMatchObject({
    tools: '*',
    default_tool_policy: { read_only: false, timeout_seconds: 30 },
    tool_policies: [{ name: 'query', read_only: true, timeout_seconds: 5 }],
  });
});

test('an all-tools draft with no rows asks for the overrides to be removed', () => {
  const payload = serverPayload(draftOf(view({})));
  expect(payload.error).toBeNull();
  expect(payload.body).toMatchObject({ tools: '*', tool_policies: null });
});

test('an explicit list may be empty, matching what the file accepts', () => {
  const payload = serverPayload({ ...draftOf(view({ tools: ['echo'] })), toolsMode: 'selected', tools: [] });
  expect(payload.error).toBeNull();
  expect(payload.body).toMatchObject({ tools: [], tool_policies: [] });
});

test('a selected-tools draft sends the list with its policies and leaves the default alone', () => {
  const server = view({
    tools: ['echo', 'wait'],
    tool_policies: [
      { name: 'echo', read_only: true, timeout_seconds: 20 },
      { name: 'wait', read_only: false, timeout_seconds: 10 },
    ],
    default_tool_policy: { read_only: true, timeout_seconds: 99 },
  });
  const draft = draftOf(server);
  expect(draft.toolsMode).toBe('selected');
  const payload = serverPayload(draft);
  expect(payload.error).toBeNull();
  expect(payload.body).toMatchObject({
    tools: ['echo', 'wait'],
    tool_policies: [
      { name: 'echo', read_only: true, timeout_seconds: 20 },
      { name: 'wait', read_only: false, timeout_seconds: 10 },
    ],
  });
  // The form does not model the default policy in this mode; the write keeps
  // what the file has instead of deleting it behind the operator's back.
  expect(payload.body).not.toHaveProperty('default_tool_policy');
});

test('only presentation edits leave the connection unchanged, even where the form normalises a value', () => {
  // `tool_policies: []` in the file round-trips through the form as `null`;
  // comparing against the saved server's own form body keeps that from
  // reading as a change that would rewrite and reconnect the server.
  const server = view({ tool_policies: [] });
  const presentation = serverPayload({
    ...draftOf(server),
    exposure: 'progressive',
    description: 'Search tools.',
  }).body;
  const widened = serverPayload({ ...draftOf(server), resultMax: '1024' }).body;
  if (presentation === null || widened === null) {
    throw new Error('both drafts should be valid');
  }
  expect(connectionChanged(server, presentation)).toBe(false);
  expect(connectionChanged(server, widened)).toBe(true);
});

test('the skills switch round-trips and, alone, is a presentation change that never reconnects', () => {
  const server = view({ skills_enabled: false });
  const draft = draftOf(server);
  expect(draft.skills).toBe(false);
  const payload = serverPayload(draft);
  expect(payload.body).toMatchObject({ skills: false });
  expect(connectionChanged(server, payload.body as NonNullable<typeof payload.body>)).toBe(false);
  // A new server starts with skills on.
  expect(draftOf(null).skills).toBe(true);
  const flipped = serverPayload({ ...draft, skills: true });
  expect(flipped.body).toMatchObject({ skills: true });
  expect(connectionChanged(server, flipped.body as NonNullable<typeof flipped.body>)).toBe(false);
});
