-- Recurring alarms: Admin-defined schedules that inject a trusted prompt into
-- one Conversation. Each occurrence becomes an ordinary timer task (plugin
-- `recurring-alarm`) and travels the existing receipt pipeline. Only
-- `next_fire_at` drives wake-ups, so a host other than the local Scheduler
-- can schedule from this column alone.

CREATE TABLE recurring_alarms (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000 AND length(CAST(prompt AS BLOB)) <= 12288),
  rules_json TEXT NOT NULL CHECK (
    json_valid(rules_json) AND json_type(rules_json) = 'array' AND json_array_length(rules_json) BETWEEN 1 AND 10
  ),
  input_mode TEXT NOT NULL CHECK (input_mode IN ('builder', 'cron')),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_fire_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (enabled = 1 OR next_fire_at IS NULL)
) STRICT;

CREATE INDEX recurring_alarms_due_idx ON recurring_alarms(next_fire_at, id)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;
CREATE INDEX recurring_alarms_conversation_idx ON recurring_alarms(conversation_id, id);

-- One row per occurrence the Scheduler handled (`schedule`) and per Run now
-- (`manual`). The partial unique index makes a scheduled occurrence
-- idempotent; a manual run is not part of it because its millisecond instant
-- may coincide with a whole-minute occurrence.
CREATE TABLE recurring_alarm_firings (
  id INTEGER PRIMARY KEY,
  recurring_alarm_id INTEGER NOT NULL REFERENCES recurring_alarms(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('schedule', 'manual')),
  occurrence_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scheduled', 'skipped')),
  skip_reason TEXT,
  coalesced INTEGER NOT NULL DEFAULT 0 CHECK (coalesced BETWEEN 0 AND 1000),
  task_id INTEGER REFERENCES long_tasks(id) ON DELETE SET NULL,
  triggered_by TEXT,
  created_at TEXT NOT NULL,
  CHECK ((outcome = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK (source = 'schedule' OR (outcome = 'scheduled' AND coalesced = 0 AND triggered_by IS NOT NULL)),
  CHECK (source = 'manual' OR triggered_by IS NULL)
) STRICT;

CREATE UNIQUE INDEX recurring_alarm_firings_occurrence_idx
  ON recurring_alarm_firings(recurring_alarm_id, occurrence_at) WHERE source = 'schedule';
CREATE INDEX recurring_alarm_firings_alarm_idx ON recurring_alarm_firings(recurring_alarm_id, id);
CREATE INDEX recurring_alarm_firings_task_idx ON recurring_alarm_firings(task_id);
CREATE INDEX recurring_alarm_firings_created_idx ON recurring_alarm_firings(created_at);
