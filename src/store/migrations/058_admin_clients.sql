-- Paired Admin clients: an agent-owned Ed25519 identity instead of a long-term
-- bearer key. `admin_clients` keeps one row per paired client, revoked rows are
-- retained like API keys; the partial unique index enforces one active client
-- per public key so a re-pair cannot quietly multiply identities.
--
-- `admin_pairings` is the one-time claim ticket. Only the SHA-256 digest of the
-- `pwp_` code is stored, and `public_key` optionally pre-binds the ticket to the
-- exact key that may claim it, which is how an operator pairs a key they already
-- created with `surowan-utils auth init`.
--
-- `admin_client_nonces` makes replay rejection survive a restart: a nonce is
-- inserted only after the signature verified, and the primary key turns a
-- second use of the same nonce into a conflict.

CREATE TABLE admin_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  read_all INTEGER NOT NULL,
  write_all INTEGER NOT NULL,
  execute_paid_operations INTEGER NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 80),
  CHECK (length(public_key) = 43),
  CHECK (read_all IN (0, 1)),
  CHECK (write_all IN (0, 1)),
  CHECK (execute_paid_operations IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX admin_clients_public_key_active_key ON admin_clients(public_key) WHERE revoked_at IS NULL;

CREATE TABLE admin_pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  public_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  canceled_at TEXT,
  client_id INTEGER REFERENCES admin_clients(id),
  read_all INTEGER NOT NULL,
  write_all INTEGER NOT NULL,
  execute_paid_operations INTEGER NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 80),
  CHECK (public_key IS NULL OR length(public_key) = 43),
  CHECK (read_all IN (0, 1)),
  CHECK (write_all IN (0, 1)),
  CHECK (execute_paid_operations IN (0, 1)),
  -- A consumed ticket names the client it became; an open ticket names nobody.
  CHECK ((consumed_at IS NULL) = (client_id IS NULL))
) STRICT;

CREATE INDEX admin_pairings_expiry_idx ON admin_pairings(expires_at);

CREATE TABLE admin_client_nonces (
  client_id INTEGER NOT NULL REFERENCES admin_clients(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, nonce)
) STRICT, WITHOUT ROWID;

CREATE INDEX admin_client_nonces_expiry_idx ON admin_client_nonces(expires_at);
