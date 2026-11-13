import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';

/** The `long_tasks.plugin_id` of recurring alarm occurrences; only trusted runtime code writes it. */
export const RECURRING_ALARM_PLUGIN_ID = 'recurring-alarm';

/**
 * One occurrence's task payload: a snapshot of the definition at the moment it
 * fired, so a later edit never changes what an already scheduled run says.
 */
export const RecurringAlarmPayloadSchema = Type.Object(
  {
    recurring_alarm_id: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    source: Type.Union([Type.Literal('schedule'), Type.Literal('manual')]),
    title: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    time_zone: Type.String({ minLength: 1 }),
    occurrence_at: Type.String({ minLength: 1 }),
    coalesced: Type.Integer({ minimum: 0, maximum: 1000 }),
  },
  { additionalProperties: false },
);

export type RecurringAlarmPayload = Static<typeof RecurringAlarmPayloadSchema>;

export const recurringAlarmPayloadValidator = Compile(RecurringAlarmPayloadSchema);
