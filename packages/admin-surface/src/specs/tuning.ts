import type { EndpointSpec } from '../types.ts';

/**
 * Manage → Developer and Manage → Harness tuning. Both edit fields of
 * `config.jsonc` through the same revision-checked write path as the panel.
 */
export const TUNING_SPECS: readonly EndpointSpec[] = [
  {
    command: 'developer show',
    method: 'GET',
    path: 'developer',
    summary: 'Show the file and active values of the debug recording switches and the model metadata catalog address',
  },
  {
    command: 'developer update',
    method: 'PUT',
    path: 'developer',
    body: true,
    revision: 'config',
    summary: 'Save and hot-apply the debug recording switches and the model metadata catalog address (models_dev_url)',
  },
  {
    command: 'developer clear-payloads',
    method: 'DELETE',
    path: 'developer/model-payloads',
    confirm: 'destructive',
    summary: 'Clear stored model request/response payloads in batches',
  },
  {
    command: 'harness show',
    method: 'GET',
    path: 'harness',
    summary: 'Show saved and active agent tuning fields plus global proactive reply defaults',
  },
  {
    command: 'harness update',
    method: 'PUT',
    path: 'harness',
    body: true,
    revision: 'config',
    summary: 'Save changed tuning fields; null removes an optional field',
  },
];
