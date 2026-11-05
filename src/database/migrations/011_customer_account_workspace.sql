ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN professional_role TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN street_address TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN region TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN postal_code TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE customer_gallery_files (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_gallery_user_created ON customer_gallery_files(user_id, created_at DESC);

CREATE TABLE customer_support_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'platform_owner')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);
CREATE INDEX idx_customer_support_messages_user ON customer_support_messages(user_id, id);
