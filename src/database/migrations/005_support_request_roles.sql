ALTER TABLE admin_support_requests
ADD COLUMN requested_roles_json TEXT NOT NULL DEFAULT '[]';
