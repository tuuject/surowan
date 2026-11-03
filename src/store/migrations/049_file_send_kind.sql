-- Pictures sent uncompressed as files: host_sends gains the 'file' kind.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt in place.
-- Nothing references host_sends, so foreign keys stay enforced throughout;
-- rows move 1:1 and the indexes are recreated unchanged. A file send keeps its
-- own kind so the image delivery index and dedup never count it as a photo.

CREATE TABLE host_sends_new (
  id INTEGER PRIMARY KEY,
  tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'image', 'file')),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown')),
  telegram_message_id INTEGER,
  response_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
) STRICT;

INSERT INTO host_sends_new
  (id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, error_code, created_at, finished_at, message_id)
SELECT
  id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, error_code, created_at, finished_at, message_id
FROM host_sends;

DROP TABLE host_sends;
ALTER TABLE host_sends_new RENAME TO host_sends;

CREATE INDEX host_sends_reply_delivery_idx
ON host_sends(conversation_id, json_extract(request_json, '$.reply_to_message_id'))
WHERE state IN ('success', 'pending', 'outcome_unknown');

CREATE INDEX host_sends_image_delivery_idx
ON host_sends(conversation_id, json_extract(request_json, '$.generation_id'))
WHERE kind = 'image';

CREATE INDEX host_sends_message_idx
ON host_sends(message_id)
WHERE message_id IS NOT NULL;
