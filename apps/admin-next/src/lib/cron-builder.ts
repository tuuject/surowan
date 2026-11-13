/**
 * The rule builder and cron text are two editors of one rule list. The server
 * only stores cron strings; a builder rule always becomes cron, while cron
 * only becomes a builder rule when every field is one of the shapes the
 * builder can show (`*`, `*\/N` or a list of numbers).
 */

export const FIELD_KEYS = ['minute', 'hour', 'day', 'month', 'weekday'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type FieldMode = 'every' | 'at';

export interface BuilderField {
  readonly mode: FieldMode;
  /** `every` only: empty means every unit, `N` means every N units. */
  readonly step: string;
  /** `at` only: the chosen values. */
  readonly values: readonly number[];
}

export type BuilderRule = Readonly<Record<FieldKey, BuilderField>>;

export const FIELD_RANGES: Readonly<Record<FieldKey, { readonly min: number; readonly max: number }>> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  day: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  weekday: { min: 0, max: 6 },
};

const EVERY: BuilderField = { mode: 'every', step: '', values: [] };

function at(...values: number[]): BuilderField {
  return { mode: 'at', step: '', values };
}

/** Every day at 08:00, the shape most recurring alarms start from. */
export function defaultBuilderRule(): BuilderRule {
  return { minute: at(0), hour: at(8), day: EVERY, month: EVERY, weekday: EVERY };
}

function fieldToCron(field: BuilderField): string {
  if (field.mode === 'every') {
    return field.step.length === 0 ? '*' : `*/${field.step}`;
  }
  return [...new Set(field.values)].sort((left, right) => left - right).join(',');
}

export function ruleToCron(rule: BuilderRule): string {
  return FIELD_KEYS.map((key) => fieldToCron(rule[key])).join(' ');
}

function cronToField(text: string, key: FieldKey): BuilderField | undefined {
  if (text === '*') {
    return EVERY;
  }
  const step = /^\*\/([1-9][0-9]?)$/.exec(text);
  if (step?.[1] !== undefined) {
    return { mode: 'every', step: step[1], values: [] };
  }
  if (!/^[0-9]{1,2}(,[0-9]{1,2})*$/.test(text)) {
    return undefined;
  }
  const values = text.split(',').map(Number);
  const range = FIELD_RANGES[key];
  return values.every((value) => value >= range.min && value <= range.max) ? at(...values) : undefined;
}

/** The builder form of one cron rule, or undefined when it needs the cron editor. */
export function cronToRule(cron: string): BuilderRule | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== FIELD_KEYS.length) {
    return undefined;
  }
  const fields: Partial<Record<FieldKey, BuilderField>> = {};
  for (const [index, key] of FIELD_KEYS.entries()) {
    const field = cronToField(parts[index] ?? '', key);
    if (field === undefined) {
      return undefined;
    }
    fields[key] = field;
  }
  const { minute, hour, day, month, weekday } = fields;
  return minute === undefined || hour === undefined || day === undefined || month === undefined || weekday === undefined
    ? undefined
    : { minute, hour, day, month, weekday };
}

/** Parses the comma list an `at` field is typed as; undefined when a value is not in range. */
export function parseFieldValues(text: string, key: FieldKey): number[] | undefined {
  const parts = text
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!parts.every((part) => /^[0-9]{1,2}$/.test(part))) {
    return undefined;
  }
  const values = parts.map(Number);
  const range = FIELD_RANGES[key];
  return values.every((value) => value >= range.min && value <= range.max) ? values : undefined;
}

/** Fields the builder cannot turn into cron yet: an `at` field with nothing chosen, or a bad step. */
export function incompleteFields(rule: BuilderRule): FieldKey[] {
  return FIELD_KEYS.filter((key) => {
    const field = rule[key];
    if (field.mode === 'at') {
      return field.values.length === 0;
    }
    if (field.step.length === 0) {
      return false;
    }
    const step = Number(field.step);
    const range = FIELD_RANGES[key];
    return !/^[1-9][0-9]?$/.test(field.step) || step > range.max - range.min + 1;
  });
}

/** One rule per non-empty line of the cron editor. */
export function cronLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
