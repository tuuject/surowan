-- @rebuild-tables
-- One-time pairing tickets gain a purpose. `client` is the 058 ticket that
-- `surowan-utils auth pair` turns into a signed client. `web` is claimed on the
-- Admin Panel login page and turns into a panel session for `user_id`, so an
-- operator with shell access can sign a browser in without a password.
--
-- A panel session carries the panel's whole authority, so a web ticket records
-- every permission bit; it never has a public key or a client. SQLite cannot
-- relax the consumed/client CHECK in place, so the table is rebuilt. Nothing
-- references it, and the AUTOINCREMENT high-water mark is carried over so an id
-- handed out before the rebuild (and since purged) is never reused.

CREATE TABLE admin_pairings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  public_key TEXT,
  user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  canceled_at TEXT,
  client_id INTEGER REFERENCES admin_clients(id),
  read_all INTEGER NOT NULL,
  write_all INTEGER NOT NULL,
  execute_paid_operations INTEGER NOT NULL,
  CHECK (purpose IN ('client', 'web')),
  CHECK (length(name) BETWEEN 1 AND 80),
  CHECK (public_key IS NULL OR length(public_key) = 43),
  CHECK (read_all IN (0, 1)),
  CHECK (write_all IN (0, 1)),
  CHECK (execute_paid_operations IN (0, 1)),
  -- A consumed client ticket names the client it became; an open one names nobody.
  CHECK (purpose <> 'client' OR (user_id IS NULL AND (consumed_at IS NULL) = (client_id IS NULL))),
  CHECK (
    purpose <> 'web'
    OR (
      user_id IS NOT NULL AND public_key IS NULL AND client_id IS NULL
      AND read_all = 1 AND write_all = 1 AND execute_paid_operations = 1
    )
  )
) STRICT;

INSERT INTO admin_pairings_new
  (id, purpose, name, code_hash, public_key, user_id, created_at, expires_at, consumed_at, canceled_at, client_id,
   read_all, write_all, execute_paid_operations)
SELECT
  id, 'client', name, code_hash, public_key, NULL, created_at, expires_at, consumed_at, canceled_at, client_id,
  read_all, write_all, execute_paid_operations
FROM admin_pairings;

DELETE FROM sqlite_sequence WHERE name = 'admin_pairings_new';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'admin_pairings_new', seq FROM sqlite_sequence WHERE name = 'admin_pairings';

DROP TABLE admin_pairings;
ALTER TABLE admin_pairings_new RENAME TO admin_pairings;

CREATE INDEX admin_pairings_expiry_idx ON admin_pairings(expires_at);
