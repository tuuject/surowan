-- Messages are never pruned, and several hot paths read one conversation
-- newest-first: the invocation snapshot's history window, ingestion's
-- adoption of pending bot messages, member-profile checks and scene renders.
-- This index serves the conversation_id equality plus the
-- (telegram_date, telegram_message_id) order, so those reads stop scanning
-- the whole table and re-sorting it on every invocation.
CREATE INDEX messages_conversation_history_idx
  ON messages(conversation_id, telegram_date, telegram_message_id);

-- Adoption asks "has this message been batched yet" by message_id alone; the
-- (bucket_id, message_id) primary key cannot answer that probe, and
-- bucket_messages grows with the message history.
CREATE INDEX bucket_messages_message_idx ON bucket_messages(message_id);
