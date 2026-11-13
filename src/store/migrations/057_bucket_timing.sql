-- Every batch records the collection timing it was opened with, so the
-- `telegram.bucket_*` fields can be reloaded without reaching a batch that is
-- already collecting: its message bumps, its ceiling and every deferral read
-- these columns, never the live configuration.
--
-- Batches that never collect (startup catch-up, task receipts, Playground
-- releases) are created due and record 0/0/0, the timing a room resolves to.
-- So do the rows stored before this migration, including a batch still
-- collecting at the upgrade: it keeps the deadline it already has, and nothing
-- extends or re-windows it.

ALTER TABLE buckets ADD COLUMN window_seconds INTEGER NOT NULL DEFAULT 0 CHECK (window_seconds >= 0);
ALTER TABLE buckets ADD COLUMN max_seconds INTEGER NOT NULL DEFAULT 0 CHECK (max_seconds >= window_seconds);
ALTER TABLE buckets ADD COLUMN bump_seconds INTEGER NOT NULL DEFAULT 0 CHECK (bump_seconds >= 0);
