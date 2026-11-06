-- SQLite cannot alter a CHECK constraint: rebuild the table to allow
-- the 'cancelled' status used by the pen-button lifecycle.
CREATE TABLE customer_profile_change_requests_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_name TEXT NOT NULL DEFAULT '',
  current_email TEXT NOT NULL DEFAULT '',
  new_name TEXT NOT NULL DEFAULT '',
  new_email TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'denied', 'cancelled')
  ),
  reviewed_by INTEGER REFERENCES admin_users(id) ON DELETE
  SET NULL,
    reviewed_at TEXT,
    owner_note TEXT NOT NULL DEFAULT '',
    support_request_id INTEGER REFERENCES admin_support_requests(id) ON DELETE
  SET NULL,
    ahead_until TEXT,
    user_acknowledged_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO customer_profile_change_requests_new (
    id,
    user_id,
    current_name,
    current_email,
    new_name,
    new_email,
    fields_json,
    reason,
    status,
    reviewed_by,
    reviewed_at,
    owner_note,
    support_request_id,
    ahead_until,
    user_acknowledged_at,
    deleted_at,
    created_at
  )
SELECT id,
  user_id,
  current_name,
  current_email,
  new_name,
  new_email,
  fields_json,
  reason,
  status,
  reviewed_by,
  reviewed_at,
  owner_note,
  support_request_id,
  ahead_until,
  user_acknowledged_at,
  deleted_at,
  created_at
FROM customer_profile_change_requests;
DROP TABLE customer_profile_change_requests;
ALTER TABLE customer_profile_change_requests_new
  RENAME TO customer_profile_change_requests;
CREATE INDEX idx_profile_change_requests_user ON customer_profile_change_requests(user_id);
CREATE INDEX idx_profile_change_requests_status ON customer_profile_change_requests(status);