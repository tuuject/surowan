-- Keep creation time immutable while each save, including deduplicated reuse,
-- renews the orphan sweep grace window. Rebuild to backfill a required column
-- without a default that could silently make future inserts look stale.
CREATE TABLE memo_blobs_new (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_saved_at TEXT NOT NULL,
  CHECK (length(id) = 36 AND substr(id, 1, 4) = 'blb_')
) STRICT;

INSERT INTO memo_blobs_new (
  id, chat_id, sha256, mime, byte_size, storage_path, created_at, last_saved_at
)
SELECT id, chat_id, sha256, mime, byte_size, storage_path, created_at, created_at
FROM memo_blobs;

DROP TABLE memo_blobs;
ALTER TABLE memo_blobs_new RENAME TO memo_blobs;

CREATE UNIQUE INDEX memo_blobs_chat_sha256_key ON memo_blobs(chat_id, sha256);
CREATE INDEX memo_blobs_chat_idx ON memo_blobs(chat_id);
