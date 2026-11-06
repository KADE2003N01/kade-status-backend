-- Link basic-info change requests into the owner support-request portal and
-- keep a permanent, customer-visible request/response history.
ALTER TABLE customer_profile_change_requests
ADD COLUMN support_request_id INTEGER REFERENCES admin_support_requests(id) ON DELETE
SET NULL;
ALTER TABLE customer_profile_change_requests
ADD COLUMN deleted_at TEXT;
ALTER TABLE admin_support_requests
ADD COLUMN customer_user_id INTEGER REFERENCES users(id) ON DELETE
SET NULL;