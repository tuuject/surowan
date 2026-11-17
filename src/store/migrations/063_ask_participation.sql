CREATE TABLE conversation_attention_new (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('ask', 'mention', 'reply_to_bot', 'keyword')),
  trigger_telegram_message_id INTEGER,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO conversation_attention_new SELECT * FROM conversation_attention;
DROP TABLE conversation_attention;
ALTER TABLE conversation_attention_new RENAME TO conversation_attention;
CREATE INDEX conversation_attention_expiry_idx ON conversation_attention(expires_at);
