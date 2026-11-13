import type {
  RecurringAlarm,
  RecurringDraft,
  RecurringInputMode,
  RecurringTargetOption,
} from './api/recurring-alarms.ts';
import {
  type BuilderRule,
  cronLines,
  cronToRule,
  defaultBuilderRule,
  type FieldKey,
  incompleteFields,
  ruleToCron,
} from './cron-builder.ts';

/** The editor state of one recurring alarm; the rules live in whichever editor is open. */
export interface RecurringFormState {
  readonly title: string;
  readonly prompt: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  /** `chat_id:message_thread_id` of the chosen target; empty until one is picked. */
  readonly target: string;
  readonly mode: RecurringInputMode;
  readonly builder: readonly BuilderRule[];
  readonly cronText: string;
}

export const PROMPT_MAX_CHARACTERS = 4000;
export const TITLE_MAX_CHARACTERS = 80;
export const RULES_MAX = 10;

export function targetKey(option: Pick<RecurringTargetOption, 'chat_id' | 'message_thread_id'>): string {
  return `${option.chat_id}:${option.message_thread_id}`;
}

export function emptyForm(timeZone: string, target: string): RecurringFormState {
  const rule = defaultBuilderRule();
  return {
    title: '',
    prompt: '',
    timeZone,
    enabled: true,
    target,
    mode: 'builder',
    builder: [rule],
    cronText: ruleToCron(rule),
  };
}

/** A saved builder alarm whose rules the builder cannot show opens in the cron editor. */
export function formFromAlarm(alarm: RecurringAlarm): RecurringFormState {
  const parsed = alarm.rules.map(cronToRule);
  const builder = parsed.every((rule) => rule !== undefined) ? (parsed as BuilderRule[]) : undefined;
  return {
    title: alarm.title,
    prompt: alarm.prompt,
    timeZone: alarm.time_zone,
    enabled: alarm.enabled,
    target: targetKey(alarm.target),
    mode: alarm.input_mode === 'builder' && builder !== undefined ? 'builder' : 'cron',
    builder: builder ?? [defaultBuilderRule()],
    cronText: alarm.rules.join('\n'),
  };
}

export function formRules(state: RecurringFormState): readonly string[] {
  return state.mode === 'builder' ? state.builder.map(ruleToCron) : cronLines(state.cronText);
}

/** The other editor with the same rules, or undefined when cron text cannot become builder rules. */
export function switchMode(state: RecurringFormState, mode: RecurringInputMode): RecurringFormState | undefined {
  if (mode === state.mode) {
    return state;
  }
  if (mode === 'cron') {
    return { ...state, mode, cronText: state.builder.map(ruleToCron).join('\n') };
  }
  const parsed = cronLines(state.cronText).map(cronToRule);
  if (parsed.length === 0 || parsed.some((rule) => rule === undefined)) {
    return undefined;
  }
  return { ...state, mode, builder: parsed as BuilderRule[] };
}

/** Builder fields that still need a value, as `rule index → fields`. */
export function incompleteBuilder(state: RecurringFormState): ReadonlyMap<number, readonly FieldKey[]> {
  const incomplete = new Map<number, readonly FieldKey[]>();
  if (state.mode === 'builder') {
    state.builder.forEach((rule, index) => {
      const fields = incompleteFields(rule);
      if (fields.length > 0) {
        incomplete.set(index, fields);
      }
    });
  }
  return incomplete;
}

export function draftFromForm(state: RecurringFormState): RecurringDraft {
  return {
    title: state.title.trim(),
    prompt: state.prompt,
    rules: formRules(state),
    input_mode: state.mode,
    time_zone: state.timeZone.trim(),
    enabled: state.enabled,
  };
}

export function promptLength(prompt: string): number {
  return [...prompt].length;
}
