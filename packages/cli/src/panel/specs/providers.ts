import type { EndpointSpec } from '../types.ts';

/**
 * Models page: the provider/model manager, its read-shaped discovery calls, the
 * billed health check, and the three single-field switches that share the same
 * write path (`model`, `vision`, `thinking-level`).
 */
export const PROVIDER_SPECS: readonly EndpointSpec[] = [
  {
    command: 'provider list',
    method: 'GET',
    path: 'providers',
    summary: 'Show the on-disk providers, model definitions and pending restart fields',
  },
  {
    command: 'provider create',
    method: 'POST',
    path: 'providers',
    body: true,
    revision: 'config',
    summary: 'Create a provider with its initial models',
  },
  {
    command: 'provider update',
    method: 'PUT',
    path: 'providers/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    body: true,
    revision: 'config',
    summary: 'Update a connection; a new base_url requires re-sending its credentials',
  },
  {
    command: 'provider delete',
    method: 'DELETE',
    path: 'providers/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Delete a provider that nothing references',
  },
  {
    command: 'provider discover',
    method: 'POST',
    path: 'providers/discover',
    body: true,
    summary: 'Fetch a provider model list and metadata (also the panel Test button)',
  },
  {
    command: 'provider lookup-metadata',
    method: 'POST',
    path: 'providers/lookup-metadata',
    body: true,
    summary: 'Resolve metadata for manually entered model ids',
  },
  {
    command: 'provider health-check',
    method: 'POST',
    path: 'providers/health-check',
    body: true,
    confirm: 'paid',
    summary: 'Send one real prompt to a configured model (billed)',
  },
  {
    command: 'model add',
    method: 'POST',
    path: 'providers/:alias/models',
    positional: [{ name: 'alias', kind: 'text' }],
    body: true,
    revision: 'config',
    summary: 'Append model definitions to a provider',
  },
  {
    command: 'model update',
    method: 'PUT',
    path: 'providers/:alias/models/:id',
    positional: [
      { name: 'alias', kind: 'text' },
      { name: 'id', kind: 'text' },
    ],
    body: true,
    revision: 'config',
    summary: 'Replace one model definition',
  },
  {
    command: 'model delete',
    method: 'DELETE',
    path: 'providers/:alias/models/:id',
    positional: [
      { name: 'alias', kind: 'text' },
      { name: 'id', kind: 'text' },
    ],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Delete a model that nothing references',
  },
  {
    command: 'vision set',
    method: 'PUT',
    path: 'vision',
    body: true,
    revision: 'config',
    summary: 'Switch the vision model',
  },
  {
    command: 'thinking-level set',
    method: 'PUT',
    path: 'thinking-level',
    body: true,
    revision: 'config',
    summary: 'Set the global thinking level, keeping per-Chat overrides',
  },
];
