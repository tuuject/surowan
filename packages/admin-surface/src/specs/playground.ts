import type { EndpointSpec } from '../types.ts';

/**
 * Playground virtual rooms. They use their own `revision`/`request_key` bodies
 * instead of `If-Match`, so no row here takes a revision. Releasing a room runs
 * the real agent, so it is billed.
 */
export const PLAYGROUND_SPECS: readonly EndpointSpec[] = [
  {
    command: 'room list',
    method: 'GET',
    path: 'playground/rooms',
    summary: 'List virtual rooms with their counters and hold state',
  },
  {
    command: 'room create',
    method: 'POST',
    path: 'playground/rooms',
    body: true,
    summary: 'Create a room; a repeated request_key returns the original',
  },
  {
    command: 'room show',
    method: 'GET',
    path: 'playground/rooms/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Show one room with participants, held inputs, assets and releases',
  },
  {
    command: 'room messages',
    method: 'GET',
    path: 'playground/rooms/:id/messages',
    positional: [{ name: 'id', kind: 'decimal' }],
    params: ['before', 'limit'],
    summary: 'Page through the room timeline',
  },
  {
    command: 'room send',
    method: 'POST',
    path: 'playground/rooms/:id/messages',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    summary: 'Admit one message from a room identity',
  },
  {
    command: 'room participant add',
    method: 'POST',
    path: 'playground/rooms/:id/participants',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    summary: 'Create a virtual identity in one room',
  },
  {
    command: 'room hold',
    method: 'PUT',
    path: 'playground/rooms/:id/hold',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: 'optional',
    summary: 'Open the hold so new inputs queue instead of running',
  },
  {
    command: 'room release',
    method: 'POST',
    path: 'playground/rooms/:id/releases',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    access: 'write+paid',
    confirm: 'paid',
    summary: 'Seal held inputs into one Bucket and run the agent (billed)',
  },
  {
    command: 'room release show',
    method: 'GET',
    path: 'playground/rooms/:id/releases/:releaseId',
    positional: [
      { name: 'id', kind: 'decimal' },
      { name: 'releaseId', kind: 'decimal' },
    ],
    summary: 'Show one release with its attempts and sends',
  },
  {
    command: 'room release retry',
    method: 'POST',
    path: 'playground/rooms/:id/releases/:releaseId/retry',
    positional: [
      { name: 'id', kind: 'decimal' },
      { name: 'releaseId', kind: 'text' },
    ],
    body: true,
    access: 'write+paid',
    confirm: 'paid',
    summary: 'Retry a settled attempt that had no side effects (billed)',
  },
  {
    command: 'room asset list',
    method: 'GET',
    path: 'playground/rooms/:id/assets',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'List staged room uploads',
  },
  {
    command: 'room asset upload',
    method: 'POST',
    path: 'playground/rooms/:id/assets',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    summary: 'Upload a static image as base64',
  },
  {
    command: 'room asset content',
    method: 'GET',
    path: 'playground/rooms/:id/assets/:assetId/content',
    positional: [
      { name: 'id', kind: 'decimal' },
      { name: 'assetId', kind: 'text' },
    ],
    response: 'binary',
    summary: 'Download the bytes of one room asset',
  },
  {
    command: 'room capabilities',
    method: 'PUT',
    path: 'playground/rooms/:id/capabilities',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    summary: 'Toggle the room image switch; revision travels in the body',
  },
  {
    command: 'room invocations',
    method: 'GET',
    path: 'playground/rooms/:id/invocations',
    positional: [{ name: 'id', kind: 'decimal' }],
    params: ['limit', 'offset'],
    summary: 'List one offset page of Invocations scoped to one room',
  },
  {
    command: 'room invocation show',
    method: 'GET',
    path: 'playground/rooms/:id/invocations/:invocationId',
    positional: [
      { name: 'id', kind: 'decimal' },
      { name: 'invocationId', kind: 'decimal' },
    ],
    summary: 'Show one room-scoped Invocation',
  },
];
