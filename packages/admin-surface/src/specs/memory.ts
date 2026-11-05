import type { EndpointSpec } from '../types.ts';

/**
 * Memo Pad and group memory. Memo writes are revision-free (a row is replaced
 * wholesale); group memory only lets the summary change.
 */
export const MEMORY_SPECS: readonly EndpointSpec[] = [
  {
    command: 'memo list',
    method: 'GET',
    path: 'memories',
    params: ['chat', 'state', 'limit', 'cursor'],
    summary: 'List Memo Pad entries by Chat and state',
  },
  {
    command: 'memo chats',
    method: 'GET',
    path: 'memories/chats',
    summary: 'List the Chats a memo can belong to',
  },
  {
    command: 'memo create',
    method: 'POST',
    path: 'memories',
    body: true,
    summary: 'Create a memo for one Chat; omit ttl_seconds for a permanent entry',
  },
  {
    command: 'memo update',
    method: 'PUT',
    path: 'memories/:id',
    positional: [{ name: 'id', kind: 'text' }],
    body: true,
    summary: 'Update a memo summary, detail or expiry (null makes it permanent)',
  },
  {
    command: 'memo delete',
    method: 'DELETE',
    path: 'memories/:id',
    positional: [{ name: 'id', kind: 'text' }],
    confirm: 'destructive',
    summary: 'Delete a memo and the blobs only it referenced',
  },
  {
    command: 'memo blob content',
    method: 'GET',
    path: 'memories/blobs/:id/content',
    positional: [{ name: 'id', kind: 'text' }],
    response: 'binary',
    summary: 'Download the image bytes of one memo blob',
  },
  {
    command: 'group-memory list',
    method: 'GET',
    path: 'group-memories',
    params: ['chat', 'day', 'search', 'limit', 'cursor'],
    summary: 'List generated group-memory event summaries',
  },
  {
    command: 'group-memory messages',
    method: 'GET',
    path: 'group-memories/:id/messages',
    positional: [{ name: 'id', kind: 'text' }],
    summary: 'Replay the original messages of one event',
  },
  {
    command: 'group-memory update',
    method: 'PUT',
    path: 'group-memories/:id',
    positional: [{ name: 'id', kind: 'text' }],
    body: true,
    summary: 'Rewrite the summary of one event',
  },
  {
    command: 'group-memory delete',
    method: 'DELETE',
    path: 'group-memories/:id',
    positional: [{ name: 'id', kind: 'text' }],
    confirm: 'destructive',
    summary: 'Delete one event; the sleeping watermark is not rewound',
  },
];
