/**
 * Recurring schedules: the cron dialect, its limits and the engine contract.
 *
 * The dialect is fixed here, field by field, instead of being whatever the
 * engine happens to accept. A host that computes occurrences with a different
 * engine (a Cloudflare Durable Object, say) must give the same times for the
 * same rule, so every extension engines disagree on (`L`, `W`, `#`, `?`,
 * weekday 7, seconds and year fields) is refused before an engine sees it.
 * Wake-ups never depend on the engine: the store persists each schedule's next
 * occurrence and a host only has to sleep until that instant.
 */

export const RECURRING_RULES_MAX = 10;
export const RECURRING_RULE_MAX_LENGTH = 200;
export const RECURRING_TITLE_MAX = 80;
export const RECURRING_PROMPT_MAX_CHARACTERS = 4000;
/** Keeps the prompt plus its envelope inside one 16 KiB task payload. */
export const RECURRING_PROMPT_MAX_BYTES = 12_288;
export const RECURRING_PER_CONVERSATION_MAX = 20;
export const RECURRING_PREVIEW_COUNT = 5;
/** An occurrence later than this is dropped instead of delivered late. */
export const RECURRING_MISSED_GRACE_MS = 30 * 60_000;
/** Missed occurrences folded into one delivery are counted up to this cap. */
export const RECURRING_COALESCE_CAP = 1000;
/** The panel warns (but still saves) when two occurrences come closer than this. */
export const RECURRING_SHORT_INTERVAL_MS = 5 * 60_000;

export type RuleIssueCode = 'syntax' | 'out_of_range' | 'unsupported' | 'never_fires' | 'too_many' | 'empty';

export interface RuleIssue {
  /** Index of the offending rule; -1 for an issue of the rule list itself. */
  readonly index: number;
  readonly code: RuleIssueCode;
  readonly message: string;
}

/**
 * Computes occurrences of rules that already passed {@link checkRuleDialect}.
 * Implementations are pure: no timers, no callbacks, no IO.
 */
export interface RecurringScheduleEngine {
  /** Engine-level problems, such as a rule that never fires again after `now`. */
  validate(rules: readonly string[], timeZone: string, now: Date): RuleIssue[];
  /** The earliest occurrence of any rule strictly after `after`, at minute precision; null when none exists. */
  nextAfter(rules: readonly string[], timeZone: string, after: Date): Date | null;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  {
    name: 'month',
    min: 1,
    max: 12,
    names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  },
  { name: 'day of week', min: 0, max: 6, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
];

const ITEM_PATTERN = /^(?:\*|([0-9A-Za-z]+)(?:-([0-9A-Za-z]+))?)(?:\/([0-9]+))?$/;

class DialectError extends Error {
  readonly code: RuleIssueCode;

  constructor(code: RuleIssueCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fieldValue(token: string, field: FieldSpec): number {
  if (/^[0-9]+$/.test(token)) {
    const value = Number(token);
    if (value < field.min || value > field.max) {
      throw new DialectError('out_of_range', `${field.name} must be between ${field.min} and ${field.max}`);
    }
    return value;
  }
  const named = field.names?.indexOf(token.toUpperCase()) ?? -1;
  if (named < 0) {
    throw new DialectError('unsupported', `${field.name} does not accept "${token}"`);
  }
  return field.min + named;
}

function checkField(text: string, field: FieldSpec): void {
  if (text.length === 0) {
    throw new DialectError('syntax', `${field.name} is empty`);
  }
  for (const item of text.split(',')) {
    const match = ITEM_PATTERN.exec(item);
    if (match === null) {
      throw new DialectError('unsupported', `${field.name} contains unsupported syntax "${item}"`);
    }
    const [, start, end, step] = match;
    if (step !== undefined) {
      const stepValue = Number(step);
      if (stepValue < 1 || stepValue > field.max - field.min + 1) {
        throw new DialectError('out_of_range', `${field.name} step must be between 1 and ${field.max - field.min + 1}`);
      }
      if (start !== undefined && end === undefined) {
        // `5/10` means different things to different engines; only `*/N` and `a-b/N` are portable.
        throw new DialectError('unsupported', `${field.name} step needs "*" or a range before "/"`);
      }
    }
    if (start === undefined) {
      continue;
    }
    const first = fieldValue(start, field);
    if (end !== undefined && fieldValue(end, field) < first) {
      throw new DialectError('out_of_range', `${field.name} range "${start}-${end}" runs backwards`);
    }
  }
}

/** The dialect check alone: five fields of the portable subset, no engine involved. */
export function checkRuleDialect(rule: string): { code: RuleIssueCode; message: string } | undefined {
  if (rule.length > RECURRING_RULE_MAX_LENGTH) {
    return { code: 'syntax', message: `a rule is at most ${RECURRING_RULE_MAX_LENGTH} characters` };
  }
  const fields = rule.trim().split(/\s+/);
  if (rule.trim().length === 0) {
    return { code: 'empty', message: 'the rule is empty' };
  }
  if (fields.length !== FIELDS.length) {
    return {
      code: 'syntax',
      message: `a rule has exactly 5 fields (minute hour day month weekday), not ${fields.length}`,
    };
  }
  try {
    fields.forEach((text, index) => {
      const field = FIELDS[index];
      if (field !== undefined) {
        checkField(text, field);
      }
    });
  } catch (error) {
    if (error instanceof DialectError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  return undefined;
}

/** Collapses inner whitespace so equal rules are stored and compared as equal text. */
export function normalizeRule(rule: string): string {
  return rule.trim().split(/\s+/).join(' ');
}

/** The canonical IANA name of a time zone, or undefined when the runtime does not know it. */
export function canonicalTimeZone(timeZone: string): string | undefined {
  if (timeZone.length === 0 || timeZone.length > 64) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export type ScheduleCheck =
  | { readonly ok: true; readonly rules: readonly string[]; readonly timeZone: string }
  | { readonly ok: false; readonly code: 'invalid_rules'; readonly issues: readonly RuleIssue[] }
  | { readonly ok: false; readonly code: 'invalid_time_zone' };

/** Validates a whole rule list: count, dialect, then the engine's own semantics. */
export function checkSchedule(
  engine: RecurringScheduleEngine,
  rules: readonly string[],
  timeZone: string,
  now: Date,
): ScheduleCheck {
  const zone = canonicalTimeZone(timeZone);
  if (zone === undefined) {
    return { ok: false, code: 'invalid_time_zone' };
  }
  if (rules.length === 0) {
    return {
      ok: false,
      code: 'invalid_rules',
      issues: [{ index: -1, code: 'empty', message: 'add at least one rule' }],
    };
  }
  if (rules.length > RECURRING_RULES_MAX) {
    return {
      ok: false,
      code: 'invalid_rules',
      issues: [{ index: -1, code: 'too_many', message: `at most ${RECURRING_RULES_MAX} rules` }],
    };
  }
  const normalized = rules.map(normalizeRule);
  const issues: RuleIssue[] = [];
  normalized.forEach((rule, index) => {
    const issue = checkRuleDialect(rule);
    if (issue !== undefined) {
      issues.push({ index, ...issue });
    }
  });
  if (issues.length === 0) {
    issues.push(...engine.validate(normalized, zone, now));
  }
  return issues.length === 0
    ? { ok: true, rules: normalized, timeZone: zone }
    : { ok: false, code: 'invalid_rules', issues };
}

/** The next `count` occurrences strictly after `after`. */
export function upcomingOccurrences(
  engine: RecurringScheduleEngine,
  rules: readonly string[],
  timeZone: string,
  after: Date,
  count: number,
): Date[] {
  const occurrences: Date[] = [];
  let cursor = after;
  while (occurrences.length < count) {
    const next = engine.nextAfter(rules, timeZone, cursor);
    if (next === null) {
      break;
    }
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

/** Occurrences in `(after, until]`, counted up to {@link RECURRING_COALESCE_CAP}. */
export function countOccurrences(
  engine: RecurringScheduleEngine,
  rules: readonly string[],
  timeZone: string,
  after: Date,
  until: Date,
): number {
  let count = 0;
  let cursor = after;
  while (count < RECURRING_COALESCE_CAP) {
    const next = engine.nextAfter(rules, timeZone, cursor);
    if (next === null || next.getTime() > until.getTime()) {
      break;
    }
    count += 1;
    cursor = next;
  }
  return count;
}
