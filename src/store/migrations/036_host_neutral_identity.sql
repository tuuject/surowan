-- @rebuild-tables
--
-- Host-neutral identity for the shared Message/Context store.
--
-- `chats`, `senders` and `messages` keep their Telegram identity columns, but
-- those become *conditional* metadata instead of unconditional NOT NULL, so the
-- same tables can also hold virtual (Playground) rooms and identities that have
-- no Telegram id at all. Every existing row keeps its id, its values and its
-- position in the message tree; new rows declare `host_kind`.
--
-- SQLite cannot relax a NOT NULL constraint with ALTER TABLE, so the three
-- tables are rebuilt with the documented create/copy/drop/rename procedure.
-- `chats` is a cascade parent of the whole message tree and `messages` is
-- referenced by NO ACTION tables, so a rebuild with foreign keys enforced would
-- either cascade-delete every conversation or fail outright. The migration is
-- therefore marked `@rebuild-tables`: the runner turns enforcement off for the
-- DDL window only, runs everything in one transaction and refuses to commit
-- unless `PRAGMA foreign_key_check` is clean.

CREATE TABLE chats_new (
  id INTEGER PRIMARY KEY,
  host_kind TEXT NOT NULL DEFAULT 'telegram'
    CHECK (host_kind IN ('telegram', 'playground')),
  telegram_chat_id INTEGER,
  canonical_chat_id INTEGER,
  type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (host_kind = 'telegram' AND telegram_chat_id IS NOT NULL AND canonical_chat_id IS NOT NULL)
    OR (host_kind = 'playground' AND telegram_chat_id IS NULL AND canonical_chat_id IS NULL)
  )
) STRICT;

INSERT INTO chats_new (id, host_kind, telegram_chat_id, canonical_chat_id, type, title, username, updated_at)
SELECT id, 'telegram', telegram_chat_id, canonical_chat_id, type, title, username, updated_at FROM chats;

DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;

-- Plain UNIQUE, not a partial index: SQLite treats NULLs as distinct, so rows
-- without a Telegram id never collide, while the constraint stays a valid
-- ON CONFLICT target for the ingestion upserts (partial indexes are not).
CREATE UNIQUE INDEX chats_telegram_chat_id_key ON chats (telegram_chat_id);

CREATE TABLE senders_new (
  id INTEGER PRIMARY KEY,
  host_kind TEXT NOT NULL DEFAULT 'telegram'
    CHECK (host_kind IN ('telegram', 'playground')),
  telegram_type TEXT CHECK (telegram_type IN ('user', 'sender_chat')),
  telegram_id INTEGER,
  display_name TEXT NOT NULL,
  username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (
    (host_kind = 'telegram' AND telegram_type IS NOT NULL AND telegram_id IS NOT NULL)
    OR (host_kind = 'playground' AND telegram_type IS NULL AND telegram_id IS NULL)
  )
) STRICT;

INSERT INTO senders_new (id, host_kind, telegram_type, telegram_id, display_name, username, is_bot, updated_at)
SELECT id, 'telegram', telegram_type, telegram_id, display_name, username, is_bot, updated_at FROM senders;

DROP TABLE senders;
ALTER TABLE senders_new RENAME TO senders;

CREATE UNIQUE INDEX senders_telegram_identity_key ON senders (telegram_type, telegram_id);

CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  host_kind TEXT NOT NULL DEFAULT 'telegram'
    CHECK (host_kind IN ('telegram', 'playground')),
  telegram_message_id INTEGER,
  current_revision_id INTEGER,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sent_by_bot INTEGER NOT NULL DEFAULT 0 CHECK (sent_by_bot IN (0, 1)),
  telegram_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- Local (non-Telegram) reply target and local arrival order. Telegram traffic
  -- leaves both NULL and keeps using telegram_message_id / telegram_date.
  -- Retention deletes old messages, so a local reply target is released with
  -- SET NULL rather than blocking the delete.
  local_reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  local_sequence_no INTEGER,
  CHECK (
    (host_kind = 'telegram' AND telegram_message_id IS NOT NULL)
    OR (host_kind = 'playground' AND telegram_message_id IS NULL)
  ),
  FOREIGN KEY (current_revision_id) REFERENCES message_revisions(id)
) STRICT;

INSERT INTO messages_new (
  id, conversation_id, chat_id, host_kind, telegram_message_id, current_revision_id,
  visible, sent_by_bot, telegram_date, received_at, local_reply_to_message_id, local_sequence_no
)
SELECT
  id, conversation_id, chat_id, 'telegram', telegram_message_id, current_revision_id,
  visible, sent_by_bot, telegram_date, received_at, NULL, NULL
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE UNIQUE INDEX messages_chat_telegram_message_id_key ON messages (chat_id, telegram_message_id);

CREATE INDEX messages_local_sequence_key
  ON messages (conversation_id, local_sequence_no)
  WHERE local_sequence_no IS NOT NULL;

-- Room state and membership for virtual rooms. T02 only reserves the storage
-- shape; the write API lands with the Playground store in T03.
CREATE TABLE rooms (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  -- High-water mark: the next unassigned local sequence number. Retention never
  -- reuses a number that a released batch may still reference.
  next_seq INTEGER NOT NULL DEFAULT 1,
  hold INTEGER NOT NULL DEFAULT 1 CHECK (hold IN (0, 1)),
  image_enabled INTEGER NOT NULL DEFAULT 0 CHECK (image_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE room_participants (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, sender_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX room_participants_sender_key ON room_participants (sender_id);

-- Frozen invocation snapshots gain an explicit format identifier. Existing rows
-- are stamped with the legacy format by the column default; their JSON payload
-- is not rewritten.
ALTER TABLE invocation_messages
  ADD COLUMN snapshot_format TEXT NOT NULL DEFAULT 'plasticwan.invocation-snapshot.v1';
