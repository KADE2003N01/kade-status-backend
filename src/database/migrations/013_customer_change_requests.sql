-- Customer basic-info change requests reviewed by the platform owner.
CREATE TABLE IF NOT EXISTS customer_profile_change_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_name TEXT NOT NULL DEFAULT '',
  current_email TEXT NOT NULL DEFAULT '',
  new_name TEXT NOT NULL DEFAULT '',
  new_email TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by INTEGER REFERENCES admin_users(id) ON DELETE
  SET NULL,
    reviewed_at TEXT,
    owner_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_profile_change_requests_user ON customer_profile_change_requests(user_id);
CREATE INDEX idx_profile_change_requests_status ON customer_profile_change_requests(status);
-- Customer password changes that must be confirmed by email before applying.
CREATE TABLE IF NOT EXISTS customer_password_change_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  new_password_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_password_change_requests_user ON customer_password_change_requests(user_id);