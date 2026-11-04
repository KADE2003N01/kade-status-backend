CREATE TABLE IF NOT EXISTS admin_support_requests (
  id INTEGER PRIMARY KEY,
  admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  deleted_at TEXT
);

ALTER TABLE admin_support_requests
ADD COLUMN requested_roles_json TEXT NOT NULL DEFAULT '[]';
