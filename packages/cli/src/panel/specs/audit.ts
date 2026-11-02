import type { EndpointSpec } from '../types.ts';

/**
 * The panel's read-only audit pages. These are session reads; the four
 * inspection routes an API key may also reach (`config/view`, `models`,
 * `prompts/global|group`, invocations) already have first-class commands and
 * are not repeated here.
 */
export const AUDIT_SPECS: readonly EndpointSpec[] = [
  {
    command: 'overview',
    method: 'GET',
    path: 'overview',
    summary: 'Show invocation/sticker state counts, top tools, usage and runtime status',
  },
  {
    command: 'usage',
    method: 'GET',
    path: 'usage',
    params: ['days'],
    summary: 'Show the daily usage series',
  },
  {
    command: 'context list',
    method: 'GET',
    path: 'contexts',
    params: ['chat', 'limit', 'cursor'],
    summary: 'List Conversation Contexts',
  },
  {
    command: 'context show',
    method: 'GET',
    path: 'contexts/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Show one Conversation Context with its retained messages and refs',
  },
  {
    command: 'message list',
    method: 'GET',
    path: 'messages',
    params: ['chat', 'search', 'limit', 'cursor'],
    summary: 'List stored Telegram messages',
  },
  {
    command: 'message show',
    method: 'GET',
    path: 'messages/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Show one message with all of its revisions and media',
  },
  {
    command: 'sticker-set list',
    method: 'GET',
    path: 'sticker-sets',
    summary: 'List configured sticker sets and their index progress',
  },
  {
    command: 'sticker list',
    method: 'GET',
    path: 'stickers',
    params: ['sticker-set=set', 'state', 'search', 'limit', 'cursor'],
    summary: 'List indexed stickers',
  },
  {
    command: 'alarm list',
    method: 'GET',
    path: 'alarms',
    params: ['state', 'chat', 'target', 'limit', 'cursor'],
    summary: 'List Alarm projections of long-running tasks',
  },
];
