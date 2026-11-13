import {
  checkSchedule,
  RECURRING_PROMPT_MAX_BYTES,
  RECURRING_PROMPT_MAX_CHARACTERS,
  RECURRING_TITLE_MAX,
  type RecurringScheduleEngine,
  type RuleIssue,
} from '../../platform/recurring-schedule.ts';
import type { recurringAlarms } from '../schema/index.ts';

export type RecurringAlarmErrorCode =
  | 'invalid_rules'
  | 'invalid_time_zone'
  | 'invalid_title'
  | 'invalid_prompt'
  | 'target_unavailable'
  | 'too_many_recurring_alarms'
  | 'not_found'
  | 'revision_conflict'
  | 'previous_pending';

export class RecurringAlarmError extends Error {
  readonly code: RecurringAlarmErrorCode;
  readonly issues: readonly RuleIssue[];

  constructor(code: RecurringAlarmErrorCode, message: string, issues: readonly RuleIssue[] = []) {
    super(message);
    this.name = 'RecurringAlarmError';
    this.code = code;
    this.issues = issues;
  }
}

export type RecurringInputMode = 'builder' | 'cron';

export interface RecurringAlarmDraft {
  readonly title: string;
  readonly prompt: string;
  readonly rules: readonly string[];
  readonly inputMode: RecurringInputMode;
  readonly timeZone: string;
  readonly enabled: boolean;
}

export interface RecurringAlarmRecord {
  readonly id: bigint;
  readonly conversationId: bigint;
  readonly title: string;
  readonly prompt: string;
  readonly rules: readonly string[];
  readonly inputMode: RecurringInputMode;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly nextFireAt: string | null;
  readonly revision: bigint;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A draft that passed every check, with its rules and time zone in canonical form. */
export interface ValidDraft {
  readonly title: string;
  readonly rules: readonly string[];
  readonly timeZone: string;
}

function codePoints(text: string): number {
  let length = 0;
  for (const _ of text) {
    length += 1;
  }
  return length;
}

export function validateDraft(engine: RecurringScheduleEngine, draft: RecurringAlarmDraft, now: Date): ValidDraft {
  const title = draft.title.trim();
  if (title.length === 0 || codePoints(title) > RECURRING_TITLE_MAX || /\p{Cc}/u.test(title)) {
    throw new RecurringAlarmError(
      'invalid_title',
      `title must be 1 to ${RECURRING_TITLE_MAX} characters without control characters`,
    );
  }
  if (
    draft.prompt.trim().length === 0 ||
    codePoints(draft.prompt) > RECURRING_PROMPT_MAX_CHARACTERS ||
    // The JSON-escaped form is what the task payload stores.
    Buffer.byteLength(JSON.stringify(draft.prompt), 'utf8') > RECURRING_PROMPT_MAX_BYTES
  ) {
    throw new RecurringAlarmError(
      'invalid_prompt',
      `prompt must be 1 to ${RECURRING_PROMPT_MAX_CHARACTERS} characters and at most ${RECURRING_PROMPT_MAX_BYTES} bytes once encoded`,
    );
  }
  const schedule = checkSchedule(engine, draft.rules, draft.timeZone, now);
  if (!schedule.ok) {
    if (schedule.code === 'invalid_time_zone') {
      throw new RecurringAlarmError('invalid_time_zone', 'time_zone must be an IANA time zone name');
    }
    throw new RecurringAlarmError('invalid_rules', 'Some rules are invalid', schedule.issues);
  }
  return { title, rules: schedule.rules, timeZone: schedule.timeZone };
}

function parseRules(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((rule) => typeof rule === 'string')) {
    throw new Error('recurring_alarms.rules_json is not an array of strings');
  }
  return value;
}

export function toRecord(row: typeof recurringAlarms.$inferSelect): RecurringAlarmRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title,
    prompt: row.prompt,
    rules: parseRules(row.rulesJson),
    inputMode: row.inputMode,
    timeZone: row.timeZone,
    enabled: row.enabled,
    nextFireAt: row.nextFireAt,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
