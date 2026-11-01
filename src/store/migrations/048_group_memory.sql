-- Group memory: dated event summaries produced by the sleeping worker. Each row
-- keeps the inclusive Telegram message-id range it summarizes, which is the
-- second disclosure layer the recall tool reads raw messages from. The state row
-- is the per-Chat consolidation watermark and its claim/backoff record.

CREATE TABLE group_memories (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_message_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(summary) BETWEEN 1 AND 150),
  CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (first_message_id > 0),
  CHECK (last_message_id >= first_message_id)
) STRICT;

CREATE INDEX group_memories_chat_day_idx ON group_memories(chat_id, day, first_message_id);
CREATE INDEX group_memories_chat_range_idx ON group_memories(chat_id, first_message_id, last_message_id);

CREATE TABLE group_memory_state (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  -- Highest Telegram message id already consolidated. 0 = nothing yet.
  consolidated_through_message_id INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',
  claimed_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL,
  CHECK (state IN ('idle', 'running')),
  CHECK (consolidated_through_message_id >= 0)
) STRICT;
