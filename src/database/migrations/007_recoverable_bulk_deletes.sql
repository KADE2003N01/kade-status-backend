ALTER TABLE admin_support_requests ADD COLUMN deleted_at TEXT;
ALTER TABLE admin_users ADD COLUMN deleted_at TEXT;
ALTER TABLE admin_users ADD COLUMN deleted_status TEXT;
