-- @rebuild-tables
--
-- A room input ledger row outlives its message.
--
-- Retention deletes a message once nothing frozen references it. A held input
-- has no snapshot yet, and a released one loses its snapshot with its
-- invocation, so the message (and, through the old cascade, the ledger row)
-- went away. That silently dropped a held input and freed its request key for
-- a second, different admission. The row now keeps `request_key`,
-- `fingerprint` and `seq` as a tombstone: the message link is nulled instead,
-- and only a held input is required to still have its message.
CREATE TABLE playground_inputs_new (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  revision_id INTEGER REFERENCES message_revisions(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'expired')),
  release_id INTEGER REFERENCES playground_releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (state <> 'held' OR (message_id IS NOT NULL AND revision_id IS NOT NULL))
) STRICT;

INSERT INTO playground_inputs_new
  (id, chat_id, seq, request_key, fingerprint, message_id, revision_id, state, release_id, created_at, released_at)
SELECT id, chat_id, seq, request_key, fingerprint, message_id, revision_id, state, release_id, created_at, released_at
FROM playground_inputs;

DROP TABLE playground_inputs;
ALTER TABLE playground_inputs_new RENAME TO playground_inputs;

CREATE UNIQUE INDEX playground_inputs_room_seq_idx ON playground_inputs(chat_id, seq);
CREATE UNIQUE INDEX playground_inputs_request_idx ON playground_inputs(chat_id, request_key);
CREATE INDEX playground_inputs_held_idx ON playground_inputs(chat_id, state, seq);
