import type { EndpointSpec } from '../types.ts';

/**
 * Dictionary page. Entry writes carry the entry's own `revision` as
 * `If-Match`; settings writes carry the config revision. Import and merge are
 * two-step, and the merge preview spends a tool-model call.
 */
export const DICTIONARY_SPECS: readonly EndpointSpec[] = [
  {
    command: 'dictionary list',
    method: 'GET',
    path: 'dictionary',
    params: ['scope', 'chat', 'search'],
    summary: 'List entries and name conflicts for one scope',
  },
  {
    command: 'dictionary chats',
    method: 'GET',
    path: 'dictionary/chats',
    summary: 'List configured Chats usable as a group scope',
  },
  {
    command: 'dictionary create',
    method: 'POST',
    path: 'dictionary',
    body: true,
    summary: 'Create one entry; conflicts by name are reported, not blocked',
  },
  {
    command: 'dictionary update',
    method: 'PUT',
    path: 'dictionary/:id',
    positional: [{ name: 'id', kind: 'text' }],
    body: true,
    revision: 'entry',
    summary: 'Replace one entry; requires --if-match <entry revision>',
  },
  {
    command: 'dictionary delete',
    method: 'DELETE',
    path: 'dictionary/:id',
    positional: [{ name: 'id', kind: 'text' }],
    revision: 'entry',
    confirm: 'destructive',
    summary: 'Delete one entry; requires --if-match <entry revision>',
  },
  {
    command: 'dictionary settings show',
    method: 'GET',
    path: 'dictionary/settings',
    params: ['chat'],
    summary: 'Show the global injection mode and one Chat override',
  },
  {
    command: 'dictionary settings update',
    method: 'PUT',
    path: 'dictionary/settings',
    params: ['chat'],
    body: true,
    revision: 'config',
    summary: 'Set the global injection mode, or one Chat override (null inherits)',
  },
  {
    command: 'dictionary import preview',
    method: 'POST',
    path: 'dictionary/import/preview',
    body: true,
    access: 'read',
    summary: 'Parse an import file and report normalized drafts and conflicts',
  },
  {
    command: 'dictionary import apply',
    method: 'POST',
    path: 'dictionary/import',
    body: true,
    summary: 'Create the previewed entries in one transaction',
  },
  {
    command: 'dictionary export',
    method: 'GET',
    path: 'dictionary/export',
    params: ['scope', 'chat', 'format'],
    response: 'text',
    summary: 'Export one scope as CSV or JSONL',
  },
  {
    command: 'dictionary merge preview',
    method: 'POST',
    path: 'dictionary/merge/preview',
    body: true,
    access: 'paid',
    confirm: 'paid',
    summary: 'Draft a merged entry with the tool model (one billed call)',
  },
  {
    command: 'dictionary merge apply',
    method: 'POST',
    path: 'dictionary/merge',
    body: true,
    confirm: 'destructive',
    summary: 'Create the merged entry and optionally delete its sources',
  },
  {
    command: 'tool-model set',
    method: 'PUT',
    path: 'tool-model',
    body: true,
    revision: 'config',
    summary: 'Set the auxiliary tool model, or { inherit: true } to inherit the agent model',
  },
];
