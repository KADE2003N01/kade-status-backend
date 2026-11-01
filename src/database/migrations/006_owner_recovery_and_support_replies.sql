ALTER TABLE platform_admin_audit ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS admin_support_request_responses (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES admin_support_requests(id) ON DELETE CASCADE,
  responder_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
