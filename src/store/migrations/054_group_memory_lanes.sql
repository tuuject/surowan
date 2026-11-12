-- @rebuild-tables
--
-- Group memory throughput (see the 2026-11-12 backlog investigation).
--
-- * A summary may now hold 200 characters. The consolidation prompt still asks
--   for 150, so a model that overshoots a little no longer fails a whole batch.
-- * The single per-Chat watermark becomes lanes. The live lane follows new
--   messages; an optional backfill lane works through an old backlog between
--   its own cursor and `until_message_id`. Each lane has its own claim and
--   backoff, so a backlog no longer delays today's messages and a failing
--   backfill batch no longer blocks the live lane. A lane row exists only while
--   group memory is active for the Chat: switching it off deletes the lanes,
--   and switching it on again starts a fresh live lane after the newest stored
--   message instead of replaying everything in between.
-- * Every consolidation batch is recorded in `group_memory_runs`, so progress
--   and failure reasons can be read per Chat and lane. `model_calls` cannot do
--   that: its tool rows carry no Chat and are shared with dictionary merges.
CREATE TABLE group_memories_new (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_message_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(summary) BETWEEN 1 AND 200),
  CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (first_message_id > 0),
  CHECK (last_message_id >= first_message_id)
) STRICT;

INSERT INTO group_memories_new (id, chat_id, day, summary, first_message_id, last_message_id, created_at)
SELECT id, chat_id, day, summary, first_message_id, last_message_id, created_at
FROM group_memories;

DROP TABLE group_memories;
ALTER TABLE group_memories_new RENAME TO group_memories;

CREATE INDEX group_memories_chat_day_idx ON group_memories(chat_id, day, first_message_id);
CREATE INDEX group_memories_chat_range_idx ON group_memories(chat_id, first_message_id, last_message_id);

CREATE TABLE group_memory_lanes (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  -- Highest Telegram message id this lane has consolidated.
  through_message_id INTEGER NOT NULL DEFAULT 0,
  -- Backfill only: the inclusive last message id the lane covers. The live lane
  -- starts after it, so the two lanes never summarize the same message.
  until_message_id INTEGER,
  state TEXT NOT NULL DEFAULT 'idle',
  claimed_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, lane),
  CHECK (lane IN ('live', 'backfill')),
  CHECK (state IN ('idle', 'running')),
  CHECK (through_message_id >= 0),
  CHECK (consecutive_failures >= 0),
  CHECK (
    (lane = 'live' AND until_message_id IS NULL)
    OR (lane = 'backfill' AND until_message_id IS NOT NULL AND until_message_id >= through_message_id)
  )
) STRICT;

-- The process is stopped while migrating, so no claim is live.
INSERT INTO group_memory_lanes (
  chat_id, lane, through_message_id, until_message_id, state, claimed_at, last_attempt_at, last_success_at,
  next_attempt_at, error_code, consecutive_failures, created_at, updated_at
)
SELECT chat_id, 'live', consolidated_through_message_id, NULL, 'idle', NULL, last_attempt_at, last_success_at,
  next_attempt_at, error_code, 0, updated_at, updated_at
FROM group_memory_state;

DROP TABLE group_memory_state;

CREATE TABLE group_memory_runs (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  day TEXT NOT NULL,
  first_message_id INTEGER NOT NULL,
  through_message_id INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  state TEXT NOT NULL,
  events INTEGER,
  model_calls INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (lane IN ('live', 'backfill')),
  CHECK (state IN ('running', 'success', 'error')),
  CHECK (messages >= 0),
  CHECK (model_calls >= 0),
  CHECK (through_message_id >= first_message_id)
) STRICT;

CREATE INDEX group_memory_runs_chat_started_idx ON group_memory_runs(chat_id, started_at);
CREATE INDEX group_memory_runs_started_idx ON group_memory_runs(started_at);
