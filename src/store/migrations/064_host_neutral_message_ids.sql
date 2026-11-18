-- @rebuild-tables
--
-- Host-neutral storage identifiers.
--
-- The store no longer spells one host's identity in shared column names:
-- `chats.telegram_chat_id` becomes `host_chat_id`, `senders.telegram_type` /
-- `telegram_id` become `host_sender_type` / `host_sender_id`, and the two
-- per-host message numbering columns (`telegram_message_id` for Telegram,
-- `local_sequence_no` for rooms) merge into `messages.message_no`, the single
-- chat-scoped number the model sees, replies to and gets cut off by.
-- `messages.telegram_date` becomes `sent_at`. Every row keeps its id and its
-- values; the merged number is `COALESCE(telegram_message_id, local_sequence_no)`
-- and its NOT NULL is the migration's built-in gate: a row that carried
-- neither number aborts the copy and rolls everything back.
--
-- The identity CHECKs and `host_kind` defaults that baked the two host names
-- into the schema are gone with the column names. Whether a `host_kind` is
-- valid and whether that host must carry a native id is now an application
-- concern; the unique constraints simply gain `host_kind` as their leading
-- column, so the same native id may exist once per host. Writes that omit
-- `host_kind` now fail instead of silently becoming Telegram rows.
--
-- Rebuilding `chats`, `senders`, `messages` and `media` (the last only drops
-- its `host_kind` default) needs foreign keys suspended for the DDL window;
-- see the `@rebuild-tables` contract in the migration runner.

CREATE TABLE chats_new (
  id INTEGER PRIMARY KEY,
  host_kind TEXT NOT NULL,
  host_chat_id INTEGER,
  canonical_chat_id INTEGER,
  type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO chats_new (id, host_kind, host_chat_id, canonical_chat_id, type, title, username, updated_at)
SELECT id, host_kind, telegram_chat_id, canonical_chat_id, type, title, username, updated_at FROM chats;

DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;

-- Plain UNIQUE, not a partial index: SQLite treats NULLs as distinct, so rows
-- without a host id never collide, while the constraint stays a valid
-- ON CONFLICT target for the ingestion upserts (partial indexes are not).
CREATE UNIQUE INDEX chats_host_chat_id_key ON chats (host_kind, host_chat_id);

CREATE TABLE senders_new (
  id INTEGER PRIMARY KEY,
  host_kind TEXT NOT NULL,
  host_sender_type TEXT,
  host_sender_id INTEGER,
  display_name TEXT NOT NULL,
  username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO senders_new (id, host_kind, host_sender_type, host_sender_id, display_name, username, is_bot, updated_at)
SELECT id, host_kind, telegram_type, telegram_id, display_name, username, is_bot, updated_at FROM senders;

DROP TABLE senders;
ALTER TABLE senders_new RENAME TO senders;

CREATE UNIQUE INDEX senders_host_identity_key ON senders (host_kind, host_sender_type, host_sender_id);

CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  host_kind TEXT NOT NULL,
  message_no INTEGER NOT NULL,
  current_revision_id INTEGER,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sent_by_bot INTEGER NOT NULL DEFAULT 0 CHECK (sent_by_bot IN (0, 1)),
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- Local (non-Telegram) reply target. Retention deletes old messages, so a
  -- local reply target is released with SET NULL rather than blocking the
  -- delete.
  local_reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (current_revision_id) REFERENCES message_revisions(id)
) STRICT;

INSERT INTO messages_new (
  id, conversation_id, chat_id, host_kind, message_no, current_revision_id,
  visible, sent_by_bot, sent_at, received_at, local_reply_to_message_id
)
SELECT
  id, conversation_id, chat_id, host_kind, COALESCE(telegram_message_id, local_sequence_no), current_revision_id,
  visible, sent_by_bot, telegram_date, received_at, local_reply_to_message_id
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- One numbering column, one uniqueness rule per chat: it replaces both
-- messages_chat_telegram_message_id_key and messages_local_sequence_key and
-- stays a valid ON CONFLICT target for the ingestion upsert.
CREATE UNIQUE INDEX messages_chat_message_no_key ON messages (chat_id, message_no);

-- The history window keeps its shape: conversation equality plus the
-- (sent_at, message_no) order the snapshot and adoption readers sort by.
CREATE INDEX messages_conversation_history_idx
  ON messages(conversation_id, sent_at, message_no);

-- `media` is rebuilt only to drop the `host_kind` default; its columns are
-- unchanged.
CREATE TABLE media_new (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES message_revisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'document', 'sticker')),
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  telegram_json TEXT NOT NULL,
  host_kind TEXT NOT NULL,
  local_asset_id TEXT
) STRICT;

INSERT INTO media_new (id, revision_id, kind, file_id, file_unique_id, mime_type, file_size, width, height,
  telegram_json, host_kind, local_asset_id)
SELECT id, revision_id, kind, file_id, file_unique_id, mime_type, file_size, width, height,
  telegram_json, host_kind, local_asset_id FROM media;

DROP TABLE media;
ALTER TABLE media_new RENAME TO media;

CREATE INDEX media_revision_idx ON media(revision_id);
CREATE INDEX media_unique_idx ON media(file_unique_id);

-- Plain renames; values and nullability are untouched.
ALTER TABLE conversation_context_cutoffs RENAME COLUMN telegram_message_id TO message_no;
ALTER TABLE conversation_attention RENAME COLUMN trigger_telegram_message_id TO trigger_message_no;
ALTER TABLE host_sends RENAME COLUMN telegram_message_id TO message_no;
