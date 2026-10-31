-- Memory Phase 1: Memo Pad, chat-scoped memory with summary/detail, optional
-- expiry and chat-owned blobs. Old conversation-scoped `memories` rows are
-- merged into their Chat's Memo Pad: summary and detail both start as the old
-- content, and the original expiry is preserved.
--
-- `conversation_contexts` gains the short-term snapshot state. The full list is
-- rendered only when the retained window no longer carries it; every other
-- change is announced as a tail delta and the announced state is kept here so a
-- process restart never replays a change.

CREATE TABLE memo_pad_entries (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (length(summary) BETWEEN 1 AND 150),
  CHECK (length(detail) BETWEEN 1 AND 32768),
  CHECK (expires_at IS NULL OR expires_at > created_at)
) STRICT;

CREATE INDEX memo_pad_entries_chat_created_idx ON memo_pad_entries(chat_id, created_at);
CREATE INDEX memo_pad_entries_expiry_idx ON memo_pad_entries(expires_at);

CREATE TABLE memo_blobs (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(id) = 36 AND substr(id, 1, 4) = 'blb_')
) STRICT;

CREATE UNIQUE INDEX memo_blobs_chat_sha256_key ON memo_blobs(chat_id, sha256);
CREATE INDEX memo_blobs_chat_idx ON memo_blobs(chat_id);

ALTER TABLE conversation_contexts ADD COLUMN memo_refresh_seq INTEGER;
ALTER TABLE conversation_contexts ADD COLUMN memo_state_json TEXT;
ALTER TABLE conversation_contexts ADD COLUMN memo_refresh_pending INTEGER NOT NULL DEFAULT 0;

INSERT INTO memo_pad_entries (id, chat_id, summary, detail, created_at, expires_at, updated_at)
SELECT m.id, v.chat_id, m.content, m.content, m.created_at, m.expires_at, m.updated_at
FROM memories m
JOIN conversations v ON v.id = m.conversation_id;

DROP TABLE memories;
