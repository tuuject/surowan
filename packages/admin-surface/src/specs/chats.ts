import type { EndpointSpec } from '../types.ts';

/**
 * Chats page: the allowlist, per-Chat model overrides, participation windows,
 * proactive reply and the group-memory switch. Every write is hot-applied and
 * pinned by the config revision.
 */
export const CHAT_SPECS: readonly EndpointSpec[] = [
  {
    command: 'chat list',
    method: 'GET',
    path: 'chats',
    summary: 'Show configured Chats, their saved/active settings and the global defaults',
  },
  {
    command: 'chat create',
    method: 'POST',
    path: 'chats',
    body: true,
    revision: 'config',
    summary: 'Add a Chat to the allowlist',
  },
  {
    command: 'chat update',
    method: 'PUT',
    path: 'chats/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    revision: 'config',
    summary:
      'Replace the topics, model override and thinking level of one Chat; a model change refused with model_in_use needs abort_running: true to stop the runs still on the old model',
  },
  {
    command: 'chat delete',
    method: 'DELETE',
    path: 'chats/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Remove a Chat from the allowlist and delete all of its stored data',
  },
  {
    command: 'chat participation',
    method: 'PUT',
    path: 'chats/:id/participation',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    revision: 'config',
    summary: 'Replace the active-hour windows of one Chat (null inherits the global schedule)',
  },
  {
    command: 'chat proactive-reply',
    method: 'PUT',
    path: 'chats/:id/proactive-reply',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    revision: 'config',
    summary: 'Set the proactive reply override of one Chat (inherit, off or custom)',
  },
  {
    command: 'chat group-memory',
    method: 'PUT',
    path: 'chats/:id/group-memory',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    revision: 'config',
    summary: 'Toggle group memory for one Chat and optionally set its idle minutes',
  },
];
