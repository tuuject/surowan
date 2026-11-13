import Type from 'typebox';
import { Compile } from 'typebox/compile';
import {
  checkSchedule,
  RECURRING_PREVIEW_COUNT,
  RECURRING_RULE_MAX_LENGTH,
  RECURRING_RULES_MAX,
  RECURRING_SHORT_INTERVAL_MS,
  type RecurringScheduleEngine,
  type RuleIssue,
  upcomingOccurrences,
} from '../../../platform/recurring-schedule.ts';
import {
  type RecurringAlarmDraft,
  RecurringAlarmError,
  type RecurringAlarmErrorCode,
} from '../../../store/recurring-alarms/records.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { json } from '../http.ts';

const Strict = { additionalProperties: false } as const;
const DECIMAL_ID = '^(0|[1-9][0-9]{0,18})$';
const RulesSchema = Type.Array(Type.String({ maxLength: RECURRING_RULE_MAX_LENGTH }), {
  maxItems: RECURRING_RULES_MAX * 2,
});
const DraftFields = {
  title: Type.String({ maxLength: 512 }),
  prompt: Type.String({ maxLength: 32_768 }),
  rules: RulesSchema,
  input_mode: Type.Union([Type.Literal('builder'), Type.Literal('cron')]),
  time_zone: Type.String({ maxLength: 64 }),
  enabled: Type.Boolean(),
};

const draftValidator = Compile(Type.Object(DraftFields, Strict));
const createValidator = Compile(
  Type.Object(
    {
      ...DraftFields,
      chat_id: Type.String({ pattern: DECIMAL_ID }),
      message_thread_id: Type.String({ pattern: DECIMAL_ID }),
    },
    Strict,
  ),
);
const previewValidator = Compile(
  Type.Object({ rules: RulesSchema, time_zone: Type.String({ maxLength: 64 }) }, Strict),
);

const DRAFT_MESSAGE = 'Expected { title, prompt, rules: string[], input_mode: "builder" | "cron", time_zone, enabled }';
const CREATE_MESSAGE =
  'Expected { chat_id, message_thread_id, title, prompt, rules: string[], input_mode: "builder" | "cron", time_zone, enabled } with decimal string ids';

function toDraft(body: {
  title: string;
  prompt: string;
  rules: string[];
  input_mode: 'builder' | 'cron';
  time_zone: string;
  enabled: boolean;
}): RecurringAlarmDraft {
  return {
    title: body.title,
    prompt: body.prompt,
    rules: body.rules,
    inputMode: body.input_mode,
    timeZone: body.time_zone,
    enabled: body.enabled,
  };
}

export function parseRecurringDraft(body: unknown): RecurringAlarmDraft {
  if (!draftValidator.Check(body)) {
    throw new AdminQueryError('invalid_body', DRAFT_MESSAGE);
  }
  return toDraft(body);
}

export function parseRecurringCreate(body: unknown): {
  readonly chatId: bigint;
  readonly messageThreadId: bigint;
  readonly draft: RecurringAlarmDraft;
} {
  if (!createValidator.Check(body)) {
    throw new AdminQueryError('invalid_body', CREATE_MESSAGE);
  }
  return {
    chatId: BigInt(body.chat_id),
    messageThreadId: BigInt(body.message_thread_id),
    draft: toDraft(body),
  };
}

export function parseRecurringId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_id', 'id must be a positive integer');
  }
  return BigInt(value);
}

export function parseRecurringRevision(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_revision', 'If-Match must be the recurring alarm revision');
  }
  return BigInt(value);
}

export interface RecurringPreview {
  /** The next occurrences as UTC ISO-8601, empty while any rule or the time zone is invalid. */
  readonly next: readonly string[];
  readonly issues: readonly RuleIssue[];
  /** The canonical time zone, or null when it is not an IANA name. */
  readonly time_zone: string | null;
  /** Two of the listed occurrences are closer than five minutes. */
  readonly short_interval: boolean;
}

/** The schedule the panel is editing, computed without writing anything. */
export function previewSchedule(engine: RecurringScheduleEngine, body: unknown, now = new Date()): RecurringPreview {
  if (!previewValidator.Check(body)) {
    throw new AdminQueryError('invalid_body', 'Expected { rules: string[], time_zone }');
  }
  const check = checkSchedule(engine, body.rules, body.time_zone, now);
  if (!check.ok) {
    return check.code === 'invalid_time_zone'
      ? { next: [], issues: [], time_zone: null, short_interval: false }
      : { next: [], issues: check.issues, time_zone: body.time_zone, short_interval: false };
  }
  const next = upcomingOccurrences(engine, check.rules, check.timeZone, now, RECURRING_PREVIEW_COUNT);
  const shortInterval = next.some(
    (occurrence, index) =>
      index > 0 && occurrence.getTime() - (next[index - 1]?.getTime() ?? 0) < RECURRING_SHORT_INTERVAL_MS,
  );
  return {
    next: next.map((occurrence) => occurrence.toISOString()),
    issues: [],
    time_zone: check.timeZone,
    short_interval: shortInterval,
  };
}

const ERROR_STATUS: Record<RecurringAlarmErrorCode, number> = {
  invalid_rules: 400,
  invalid_time_zone: 400,
  invalid_title: 400,
  invalid_prompt: 400,
  target_unavailable: 409,
  too_many_recurring_alarms: 409,
  not_found: 404,
  revision_conflict: 409,
  previous_pending: 409,
};

/** Runs one service call and answers its domain error as the API's JSON error. */
export function recurringResponse(work: () => unknown): Response {
  try {
    return json(work());
  } catch (error) {
    if (error instanceof RecurringAlarmError) {
      return json(
        {
          error: error.code,
          message: error.message,
          ...(error.code === 'invalid_rules' ? { issues: error.issues } : {}),
        },
        ERROR_STATUS[error.code],
      );
    }
    throw error;
  }
}
