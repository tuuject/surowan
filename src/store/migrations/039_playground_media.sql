-- Playground rooms read their images from local static assets, not from a
-- Telegram file id. A media row now says which host owns it, and a local row
-- points at the asset it was built from.
ALTER TABLE media ADD COLUMN host_kind TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE media ADD COLUMN local_asset_id TEXT;

CREATE TABLE playground_assets (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  state TEXT NOT NULL,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  attached_at TEXT
);

CREATE UNIQUE INDEX playground_assets_content_idx ON playground_assets(chat_id, sha256);
CREATE INDEX playground_assets_state_idx ON playground_assets(state, created_at);