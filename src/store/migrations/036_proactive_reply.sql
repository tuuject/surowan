CREATE TABLE proactive_reply_state (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  consecutive_misses INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_misses >= 0),
  settings_fingerprint TEXT NOT NULL,
  last_sampled_at TEXT NOT NULL
) STRICT;
