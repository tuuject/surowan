-- Playground input ledger.
--
-- An admitted input is canonical at once (messages/message_revisions), but it
-- stays invisible until a release seals it: only released inputs produce a
-- bucket and an invocation. `seq` comes from rooms.next_seq and is never
-- reused, so released batches keep their order after retention.
CREATE TABLE playground_releases (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  release_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX playground_releases_key_idx ON playground_releases(chat_id, release_key);
CREATE UNIQUE INDEX playground_releases_revision_idx ON playground_releases(chat_id, revision);
CREATE UNIQUE INDEX playground_releases_invocation_idx ON playground_releases(invocation_id);

CREATE TABLE playground_inputs (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES message_revisions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'expired')),
  release_id INTEGER REFERENCES playground_releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
) STRICT;

CREATE UNIQUE INDEX playground_inputs_room_seq_idx ON playground_inputs(chat_id, seq);
CREATE UNIQUE INDEX playground_inputs_request_idx ON playground_inputs(chat_id, request_key);
CREATE INDEX playground_inputs_held_idx ON playground_inputs(chat_id, state, seq);

-- A retry keeps the original invocation untouched and records the new attempt
-- plus the invocation it retries, so the same attempt key applies at most once.
CREATE TABLE playground_retries (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL REFERENCES playground_releases(id) ON DELETE CASCADE,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  retry_of_invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  attempt_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX playground_retries_key_idx ON playground_retries(chat_id, attempt_key);
CREATE UNIQUE INDEX playground_retries_invocation_idx ON playground_retries(invocation_id);
