import type { EndpointSpec } from '../types.ts';

/**
 * Prompts page. `show` reads go through the shared inspection allowlist (an API
 * key can read them); the write rows are session-only and are pinned by the
 * prompt's own content hash, not the config revision.
 */
export const PROMPT_SPECS: readonly EndpointSpec[] = [
  {
    command: 'prompt versions',
    method: 'GET',
    path: 'prompts/versions',
    params: ['scope', 'chat'],
    summary: 'List retained versions of one prompt scope',
  },
  {
    command: 'prompt version show',
    method: 'GET',
    path: 'prompts/versions/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Show one prompt version including its content',
  },
  {
    command: 'prompt diff',
    method: 'GET',
    path: 'prompts/diff',
    params: ['from', 'to'],
    summary: 'Show a unified diff between two versions of the same scope',
  },
  {
    command: 'prompt save',
    method: 'PUT',
    path: 'prompts/:scope',
    positional: [{ name: 'scope', kind: 'enum', values: ['global', 'group'] }],
    params: ['chat'],
    body: true,
    fileField: 'prompt',
    revision: 'prompt',
    summary: 'Write the global or one group prompt and record a version',
  },
  {
    command: 'prompt restore',
    method: 'POST',
    path: 'prompts/versions/:id/restore',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: 'optional',
    revision: 'prompt',
    summary: 'Restore a version as a new rollback version',
  },
  {
    command: 'prompt cancel-running',
    method: 'POST',
    path: 'prompts/cancel-running',
    body: true,
    confirm: 'destructive',
    summary: 'Cancel only the Invocations still running under the previous prompt',
  },
];
