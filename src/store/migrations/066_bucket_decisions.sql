-- One row per Decisions entry-gate request: which Bucket was judged, with what
-- settings, and what came back. The row is the only audit of a batch that was
-- dropped before an Invocation existed (a dropped Bucket has no `model_calls`
-- to attach to and `model_calls.role` could not express this caller anyway).
--
-- The request body is not stored: the messages are already on
-- `bucket_messages` and can be rebuilt from `bucket_id`. `state` and `outcome`
-- follow the gate's two-phase flow (a `pending` row is written inside the due
-- batch's transaction, the result follows in a second one), and `applied`
-- records whether the verdict actually decided the Bucket's fate — a `stale`
-- row did not.
CREATE TABLE bucket_decisions (
  id INTEGER PRIMARY KEY,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'stale')),
  outcome TEXT CHECK (outcome IN ('enter', 'drop')),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  probability REAL,
  threshold REAL NOT NULL,
  history_count INTEGER NOT NULL DEFAULT 0 CHECK (history_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  input_tokens INTEGER,
  cost REAL,
  duration_ms INTEGER,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

-- "this Conversation's decisions, newest first": the equality column first,
-- then the ordering columns, so a backward index scan is already sorted.
CREATE INDEX bucket_decisions_conversation_time_idx
  ON bucket_decisions(conversation_id, created_at, id);

-- One Bucket's own rows, and the probe that finds them after a restart.
CREATE INDEX bucket_decisions_bucket_idx ON bucket_decisions(bucket_id);
