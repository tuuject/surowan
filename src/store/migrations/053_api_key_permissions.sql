-- API key permissions. `read:all` is always granted; the two optional grants
-- are independent. Existing keys keep their historical replay ability by
-- receiving read + execute:paid-operations.
ALTER TABLE admin_api_keys ADD COLUMN read_all INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_api_keys ADD COLUMN write_all INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_api_keys ADD COLUMN execute_paid_operations INTEGER NOT NULL DEFAULT 1;
