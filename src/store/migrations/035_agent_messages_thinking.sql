-- Allow agent_messages rows to carry the assistant's thinking (CoT) text
-- separately from its ordinary text output, so the Admin transcript can
-- distinguish the two. SQLite cannot alter a CHECK constraint in place, so
-- rebuild the table: only the thinking CHECK is removed, every other column
-- and constraint is unchanged and existing rows keep thinking_text = ''.
ALTER TABLE agent_messages RENAME TO agent_messages__old;

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('assistant', 'tool_result', 'harness_nudge')),
  text TEXT NOT NULL,
  thinking_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, sequence_no)
) STRICT;

INSERT INTO agent_messages (id, invocation_id, sequence_no, role, text, thinking_text, created_at)
  SELECT id, invocation_id, sequence_no, role, text, thinking_text, created_at FROM agent_messages__old;

DROP TABLE agent_messages__old;
