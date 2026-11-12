-- @rebuild-tables
-- Sticker sets become identified by their Telegram name: the configured alias
-- is only a nickname the panel may rename. A removed set keeps its row (and its
-- stickers' index) under the alias it last had, so aliases are unique among
-- configured sets only. SQLite cannot drop a column UNIQUE constraint, so the
-- table is rebuilt; `stickers` references it by name and keeps its rows.
-- `note` is the operator's guidance on when to use the set.

CREATE TABLE sticker_sets_new (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL,
  telegram_name TEXT NOT NULL UNIQUE,
  title TEXT,
  note TEXT,
  configured INTEGER NOT NULL DEFAULT 1 CHECK (configured IN (0, 1)),
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'running', 'success', 'error')),
  last_synced_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO sticker_sets_new
  (id, alias, telegram_name, title, note, configured, sync_state, last_synced_at, error_code, updated_at)
SELECT
  id, alias, telegram_name, title, NULL, configured, sync_state, last_synced_at, error_code, updated_at
FROM sticker_sets;

DROP TABLE sticker_sets;
ALTER TABLE sticker_sets_new RENAME TO sticker_sets;

CREATE UNIQUE INDEX sticker_sets_configured_alias_idx ON sticker_sets(alias) WHERE configured = 1;
