ALTER TABLE customer_support_messages ADD COLUMN reply_to_message_id INTEGER REFERENCES customer_support_messages(id) ON DELETE SET NULL;
ALTER TABLE customer_support_messages ADD COLUMN edited_at TEXT;
ALTER TABLE customer_support_messages ADD COLUMN deleted_at TEXT;

CREATE TABLE customer_support_message_attachments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES customer_support_messages(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_support_attachments_message ON customer_support_message_attachments(message_id);

CREATE TABLE customer_support_message_reactions (
  message_id INTEGER NOT NULL REFERENCES customer_support_messages(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('customer', 'platform_owner')),
  actor_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, actor_role, actor_id, emoji)
);

CREATE TABLE customer_support_message_flags (
  message_id INTEGER NOT NULL REFERENCES customer_support_messages(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('customer', 'platform_owner')),
  actor_id INTEGER NOT NULL,
  flag TEXT NOT NULL CHECK (flag IN ('pin', 'star')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, actor_role, actor_id, flag)
);
