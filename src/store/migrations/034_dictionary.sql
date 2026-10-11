-- Dictionary entries: global terms visible to every conversation, and group
-- terms owned by one Telegram chat (shared by its Forum Topics). Entries are
-- addressed by their own ID, so equal terms or aliases coexist by design; the
-- conflict report is a query, never a constraint.
--
-- `chat_id` is the Telegram chat ID, not `chats.id`: an entry may be authored
-- for a configured chat the bot has not stored a `chats` row for yet (for
-- example a freshly allowlisted group before its first message).
CREATE TABLE dictionary_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'group')),
  chat_id INTEGER,
  term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 200),
  definition TEXT NOT NULL CHECK (length(definition) BETWEEN 1 AND 4000),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'global' AND chat_id IS NULL) OR (scope = 'group' AND chat_id IS NOT NULL))
) STRICT;

CREATE INDEX dictionary_entries_scope_idx ON dictionary_entries(scope, chat_id, id);
CREATE INDEX dictionary_entries_term_idx ON dictionary_entries(scope, chat_id, term);

-- The dictionary-merge auxiliary call is a new `model_calls` role, and SQLite
-- cannot alter a CHECK constraint in place, so the table is rebuilt. No other
-- table references `model_calls`; rows move 1:1 and the audit index returns.
CREATE TABLE model_calls_new (
  id INTEGER PRIMARY KEY,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE CASCADE,
  media_analysis_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('agent', 'vision_chat', 'vision_sticker', 'doctor', 'tool')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost REAL,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  tools_json TEXT,
  error_detail TEXT,
  request_json TEXT,
  response_json TEXT
) STRICT;

INSERT INTO model_calls_new
  (id, invocation_id, media_analysis_id, role, provider, model, attempt, state, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, total_tokens, cost, duration_ms, error_code, created_at, finished_at,
   tools_json, error_detail, request_json, response_json)
SELECT
  id, invocation_id, media_analysis_id, role, provider, model, attempt, state, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens, cost, duration_ms, error_code, created_at, finished_at,
  tools_json, error_detail, request_json, response_json
FROM model_calls;

DROP TABLE model_calls;
ALTER TABLE model_calls_new RENAME TO model_calls;

CREATE INDEX model_calls_invocation_idx ON model_calls(invocation_id);
