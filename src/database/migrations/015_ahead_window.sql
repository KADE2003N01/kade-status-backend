-- Pen-button lifecycle: approval opens a 24-hour editing window; the customer
-- acknowledges a cancelled/denied request before the pen resets.
ALTER TABLE customer_profile_change_requests
ADD COLUMN ahead_until TEXT;
ALTER TABLE customer_profile_change_requests
ADD COLUMN user_acknowledged_at TEXT;