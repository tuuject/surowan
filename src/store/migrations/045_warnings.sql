-- System warnings raised by any runtime module. Only event warnings live here:
-- standing warnings are derived from the active configuration on read and have
-- no history. An unread warning per code is enough; a repeated event updates
-- that row's variables instead of appending duplicates. Read rows are retained
-- until `read_at` passes the configured warning retention window.
-- AUTOINCREMENT keeps ids from being reused after a clear or purge, so a stale
-- panel tab marking an old id read can never hit a newer warning.
CREATE TABLE warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  variables_json TEXT NOT NULL CHECK (json_valid(variables_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT
) STRICT;

CREATE UNIQUE INDEX warnings_unread_code_unique
  ON warnings(code)
  WHERE read_at IS NULL;

CREATE INDEX warnings_unread_created_idx
  ON warnings(id)
  WHERE read_at IS NULL;

CREATE INDEX warnings_read_at_idx
  ON warnings(read_at)
  WHERE read_at IS NOT NULL;
