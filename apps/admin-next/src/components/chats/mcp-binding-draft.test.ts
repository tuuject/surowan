import { expect, test } from 'vitest';
import type { ChatEntry } from '../../lib/api/chats.ts';
import type { McpServerView } from '../../lib/api/mcp-servers.ts';
import { bindingChoices, bindingDraftsOf, bindingWriteBody, reconcileBindingDrafts } from './mcp-binding-draft.ts';

/**
 * The binding editor's draft round trips: a saved binding's policy overrides
 * must survive an open-save cycle untouched, and only the tools the operator
 * deselects may lose theirs.
 */

function server(alias: string, overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    alias,
    transport: 'stdio',
    state: null,
    connection: { kind: 'stdio', program: 'node', argument_count: 1, env: [] },
    tools: '*',
    payload_max_bytes: 32_768,
    result_max_bytes: 32_768,
    tool_policies: null,
    default_tool_policy: null,
    advertised_tools: [],
    bound_chats: [],
    ...overrides,
  } as McpServerView;
}

function chat(mcp: ChatEntry['saved'] extends { mcp: infer M } | null ? M : never): ChatEntry {
  return {
    id: '-100777',
    runtime_chat_id: '-100777',
    title: null,
    type: null,
    saved: {
      topic_ids: null,
      provider: null,
      model: null,
      thinking_level: null,
      participation: null,
      group_memory: null,
      proactive_reply: null,
      effective_proactive_reply: { enabled: false, base_probability: 0, increment: 0, hard_pity: 1 },
      timezone: null,
      mcp,
      effective: { provider: 'agent', model: 'agent-model', thinking_level: 'low' },
    },
    active: null,
  } as ChatEntry;
}

const overrides = [{ name: 'query', read_only: true, timeout_seconds: 10 }];

test('an unchanged binding round trips with its policy overrides', () => {
  const servers = { servers: [server('notes')] };
  const saved = chat([{ server: 'notes', tools: ['query'], tool_policies: overrides }]);
  const drafts = bindingDraftsOf(servers, saved);
  // An open-save with no edits submits the same binding, overrides included.
  const body = bindingWriteBody('explicit', drafts);
  expect(body).toEqual({
    mode: 'explicit',
    bindings: [{ server: 'notes', tools: ['query'], tool_policies: overrides }],
  });
});

test('deselecting a tool drops only that tool override; a wildcard binding keeps them all', () => {
  const servers = { servers: [server('notes')] };
  const saved = chat([
    {
      server: 'notes',
      tools: ['query', 'append'],
      tool_policies: [...overrides, { name: 'append', read_only: false, timeout_seconds: 5 }],
    },
  ]);
  const drafts = bindingDraftsOf(servers, saved);
  const query = drafts.get('notes');
  expect(query).toBeDefined();
  // The operator deselects `append`; its override goes, `query`'s stays.
  const narrowed = new Map(drafts);
  narrowed.set('notes', { ...(query as NonNullable<typeof query>), tools: new Set(['query']) });
  expect(bindingWriteBody('explicit', narrowed)).toEqual({
    mode: 'explicit',
    bindings: [{ server: 'notes', tools: ['query'], tool_policies: overrides }],
  });
  // All tools keeps every override: they apply to the whole exposed set.
  const widened = new Map(drafts);
  widened.set('notes', { ...(query as NonNullable<typeof query>), allTools: true });
  expect(bindingWriteBody('explicit', widened)).toEqual({
    mode: 'explicit',
    bindings: [
      {
        server: 'notes',
        tool_policies: [
          { name: 'query', read_only: true, timeout_seconds: 10 },
          { name: 'append', read_only: false, timeout_seconds: 5 },
        ],
      },
    ],
  });
});

test('a server that appears while the dialog is open becomes bindable', () => {
  const before = { servers: [server('notes')] };
  const drafts = bindingDraftsOf(before, chat([{ server: 'notes', tools: ['query'] }]));
  // The operator binds nothing new yet; another writer adds a server.
  const after = [server('notes'), server('search')];
  const reconciled = reconcileBindingDrafts(drafts, after);
  expect(reconciled.get('search')).toEqual({
    server: 'search',
    bound: false,
    allTools: true,
    tools: new Set(),
    policies: [],
  });
  // The edit to the known alias survives the reconcile.
  expect(reconciled.get('notes')?.tools).toEqual(new Set(['query']));
  // A removed alias drops out instead of writing a binding to a ghost server.
  expect(reconcileBindingDrafts(drafts, [server('search')]).has('notes')).toBe(false);
});

test('tool choices fall back to the saved selection when discovery has nothing to offer', () => {
  const notConnected = server('notes', { tools: '*', advertised_tools: [] });
  const drafts = bindingDraftsOf({ servers: [notConnected] }, chat([{ server: 'notes', tools: ['query', 'append'] }]));
  const draft = drafts.get('notes');
  expect(draft).toBeDefined();
  // The saved narrowed selection is offered as-is, so it can be kept or
  // removed — and switching to all tools stays possible.
  expect(bindingChoices(notConnected, draft as NonNullable<typeof draft>)).toEqual(['query', 'append']);
  // Once the server connects, discovery offers the advertised names.
  const connected = server('notes', {
    tools: '*',
    advertised_tools: [{ name: 'query', description: null, input_schema: null, exposed: true, policy: null }],
  });
  expect(bindingChoices(connected, draft as NonNullable<typeof draft>)).toEqual(['query']);
  // An explicit-list server always offers its configured list.
  expect(
    bindingChoices(server('files', { tools: ['read', 'write'] }), {
      server: 'files',
      bound: true,
      allTools: true,
      tools: new Set(),
      policies: [],
    }),
  ).toEqual(['read', 'write']);
});
