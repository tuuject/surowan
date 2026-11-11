import type { EndpointSpec } from '../types.ts';

/**
 * Runtime controls: the Overview page's two destructive buttons, Alarm
 * cancellation, the Models page's live model switch, restart and the config
 * file apply/status pair.
 */
export const CONTROL_SPECS: readonly EndpointSpec[] = [
  {
    command: 'session cancel',
    method: 'POST',
    path: 'cancel-ongoing-sessions',
    confirm: 'destructive',
    summary: 'Abort every running and queued Invocation and expire their Buckets',
  },
  {
    command: 'wake',
    method: 'POST',
    path: 'wake',
    summary: 'Clear the persisted sleep state and wake the Scheduler',
  },
  {
    command: 'alarm cancel',
    method: 'DELETE',
    path: 'alarms/:id',
    positional: [{ name: 'id', kind: 'text' }],
    confirm: 'destructive',
    summary: 'Cancel a pending Alarm',
  },
  {
    command: 'model set',
    method: 'PUT',
    path: 'model',
    body: true,
    revision: 'config',
    summary:
      'Switch the global agent model and reset its thinking level; refused with model_in_use while runs use the old model unless abort_running: true stops them',
  },
  {
    command: 'provider-preset list',
    method: 'GET',
    path: 'provider-presets',
    summary: 'List the builtin providers the panel can configure',
  },
  {
    command: 'restart',
    method: 'POST',
    path: 'restart',
    confirm: 'destructive',
    summary: 'Exit with the restart code so the supervisor starts a fresh process',
  },
  {
    command: 'config apply',
    method: 'POST',
    path: 'config/apply',
    summary: 'Re-read config.jsonc and apply its hot-updatable fields',
  },
  {
    command: 'config status',
    method: 'GET',
    path: 'config/status',
    summary: 'Show the active configuration generation, hashes and last error',
  },
];
