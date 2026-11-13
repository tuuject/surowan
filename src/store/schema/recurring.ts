import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { conversations } from './core.ts';
import { longTasks } from './tasks.ts';

export const recurringAlarms = sqliteTable(
  'recurring_alarms',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    rulesJson: text('rules_json').notNull(),
    inputMode: text('input_mode').$type<'builder' | 'cron'>().notNull(),
    timeZone: text('time_zone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    nextFireAt: text('next_fire_at'),
    revision: sqliteBigInt('revision').notNull().default(1n),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('recurring_alarms_title_check', sql`length(title) BETWEEN 1 AND 80`),
    check(
      'recurring_alarms_prompt_check',
      sql`length(prompt) BETWEEN 1 AND 4000 AND length(CAST(prompt AS BLOB)) <= 12288`,
    ),
    check(
      'recurring_alarms_rules_check',
      sql`json_valid(rules_json) AND json_type(rules_json) = 'array' AND json_array_length(rules_json) BETWEEN 1 AND 10`,
    ),
    check('recurring_alarms_input_mode_check', sql`input_mode IN ('builder', 'cron')`),
    check('recurring_alarms_time_zone_check', sql`length(time_zone) BETWEEN 1 AND 64`),
    check('recurring_alarms_enabled_check', sql`enabled IN (0, 1)`),
    check('recurring_alarms_revision_check', sql`revision >= 1`),
    check('recurring_alarms_next_fire_check', sql`enabled = 1 OR next_fire_at IS NULL`),
    index('recurring_alarms_due_idx').on(t.nextFireAt, t.id).where(sql`enabled = 1 AND next_fire_at IS NOT NULL`),
    index('recurring_alarms_conversation_idx').on(t.conversationId, t.id),
  ],
);

export const recurringAlarmFirings = sqliteTable(
  'recurring_alarm_firings',
  {
    id: sqliteBigIntId('id').primaryKey(),
    recurringAlarmId: sqliteBigInt('recurring_alarm_id')
      .notNull()
      .references(() => recurringAlarms.id, { onDelete: 'cascade' }),
    source: text('source').$type<'schedule' | 'manual'>().notNull(),
    occurrenceAt: text('occurrence_at').notNull(),
    outcome: text('outcome').$type<'scheduled' | 'skipped'>().notNull(),
    skipReason: text('skip_reason'),
    coalesced: sqliteBigInt('coalesced').notNull().default(0n),
    taskId: sqliteBigInt('task_id').references(() => longTasks.id, { onDelete: 'set null' }),
    triggeredBy: text('triggered_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('recurring_alarm_firings_source_check', sql`source IN ('schedule', 'manual')`),
    check('recurring_alarm_firings_outcome_check', sql`outcome IN ('scheduled', 'skipped')`),
    check('recurring_alarm_firings_coalesced_check', sql`coalesced BETWEEN 0 AND 1000`),
    check('recurring_alarm_firings_skip_check', sql`(outcome = 'skipped') = (skip_reason IS NOT NULL)`),
    check(
      'recurring_alarm_firings_manual_check',
      sql`source = 'schedule' OR (outcome = 'scheduled' AND coalesced = 0 AND triggered_by IS NOT NULL)`,
    ),
    check('recurring_alarm_firings_schedule_check', sql`source = 'manual' OR triggered_by IS NULL`),
    uniqueIndex('recurring_alarm_firings_occurrence_idx')
      .on(t.recurringAlarmId, t.occurrenceAt)
      .where(sql`source = 'schedule'`),
    index('recurring_alarm_firings_alarm_idx').on(t.recurringAlarmId, t.id),
    index('recurring_alarm_firings_task_idx').on(t.taskId),
    index('recurring_alarm_firings_created_idx').on(t.createdAt),
  ],
);
