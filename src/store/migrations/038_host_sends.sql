-- The delivery ledger is shared by every host: a Telegram chat and a virtual
-- room record the same row and are deduplicated by the same reply/image
-- indexes. Only the host that produced the message differs, so the table and
-- its indexes get host-neutral names; ids, foreign keys, CHECK constraints,
-- state values and the Telegram response metadata stay exactly as they were.
--
-- Nothing references this table, and SQLite accepts ALTER TABLE ADD COLUMN
-- with a REFERENCES clause while foreign keys are enforced as long as the
-- column defaults to NULL, so no table rebuild and no constraint bypass is
-- needed here.
ALTER TABLE telegram_sends RENAME TO host_sends;

-- Points at the message a virtual host published for this send. Telegram keeps
-- no local copy of an accepted message, so its rows leave this NULL. Deleting
-- the message (retention) keeps the audit row and only drops the link.
ALTER TABLE host_sends ADD COLUMN message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

DROP INDEX telegram_sends_reply_delivery_idx;
CREATE INDEX host_sends_reply_delivery_idx
ON host_sends(conversation_id, json_extract(request_json, '$.reply_to_message_id'))
WHERE state IN ('success', 'pending', 'outcome_unknown');

DROP INDEX telegram_sends_image_delivery_idx;
CREATE INDEX host_sends_image_delivery_idx
ON host_sends(conversation_id, json_extract(request_json, '$.generation_id'))
WHERE kind = 'image';

CREATE INDEX host_sends_message_idx
ON host_sends(message_id)
WHERE message_id IS NOT NULL;