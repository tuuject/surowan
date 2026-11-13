import type { EndpointSpec } from '../types.ts';

/**
 * Recurring alarms: Admin-defined schedules that inject a trusted prompt into
 * one Conversation. Saving or running one lets the bot call its model later
 * without anyone present and past the daily budget, so those routes need both
 * the write and the paid grant. Literal paths come before `:id` so the
 * surface lookup resolves them first.
 */
export const RECURRING_ALARM_SPECS: readonly EndpointSpec[] = [
  {
    command: 'recurring-alarm list',
    method: 'GET',
    path: 'recurring-alarms',
    params: ['chat', 'enabled', 'limit', 'offset', 'as-of=as_of'],
    summary: 'List recurring alarms with their next occurrence and last firing',
  },
  {
    command: 'recurring-alarm targets',
    method: 'GET',
    path: 'recurring-alarms/targets',
    summary: 'List the Chats, Topics and rooms a recurring alarm may target',
  },
  {
    command: 'recurring-alarm preview',
    method: 'POST',
    path: 'recurring-alarms/preview',
    body: true,
    access: 'read',
    summary: 'Validate { rules, time_zone } and list the next five occurrences without saving',
  },
  {
    command: 'recurring-alarm create',
    method: 'POST',
    path: 'recurring-alarms',
    body: true,
    access: 'write+paid',
    confirm: 'paid',
    summary:
      'Create a recurring alarm: { chat_id, message_thread_id, title, prompt, rules, input_mode, time_zone, enabled }',
  },
  {
    command: 'recurring-alarm get',
    method: 'GET',
    path: 'recurring-alarms/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    summary: 'Show one recurring alarm with its 50 most recent firings',
  },
  {
    command: 'recurring-alarm update',
    method: 'PUT',
    path: 'recurring-alarms/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    body: true,
    revision: 'entry',
    access: 'write+paid',
    confirm: 'paid',
    summary: 'Replace a recurring alarm, including enabling or disabling it; requires --if-match <revision>',
  },
  {
    command: 'recurring-alarm delete',
    method: 'DELETE',
    path: 'recurring-alarms/:id',
    positional: [{ name: 'id', kind: 'decimal' }],
    confirm: 'destructive',
    summary: 'Delete a recurring alarm and suppress its undelivered occurrence',
  },
  {
    command: 'recurring-alarm run',
    method: 'POST',
    path: 'recurring-alarms/:id/run',
    positional: [{ name: 'id', kind: 'decimal' }],
    access: 'write+paid',
    confirm: 'paid',
    summary: 'Run the saved recurring alarm once now, outside its schedule',
  },
];
