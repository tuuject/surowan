-- Admin-side creation idempotency for Playground rooms and participants.
--
-- The message, release and retry paths already carry their own request keys in
-- `playground_inputs` / `playground_releases` / `playground_retries`. The two
-- shapes with no ledger of their own - creating a room and admitting an
-- identity into one - need the same protection: a client that lost the
-- response must be able to retry without creating a second room or a second
-- participant. `room_chat_id` is 0 for the room-creation key itself (the room
-- does not exist before the request) and the owning room for nested keys, so
-- the uniqueness scope is exactly the room a key belongs to.
CREATE TABLE playground_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  room_chat_id INTEGER NOT NULL DEFAULT 0,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind IN ('room', 'participant'))
);

CREATE UNIQUE INDEX playground_mutations_key_idx
  ON playground_mutations(kind, room_chat_id, request_key);
