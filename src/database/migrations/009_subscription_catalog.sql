INSERT INTO plans (id, name, price_minor, currency, active) VALUES
  ('standard', 'Standard', 10000, 'RWF', 1),
  ('professional', 'Professional', 15000, 'RWF', 1)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  active = excluded.active;

INSERT OR IGNORE INTO plan_features (plan_id, feature_key, value_json) VALUES
  ('standard', 'documents', '10'),
  ('standard', 'storage_mb', '50'),
  ('standard', 'otp_gate', 'true'),
  ('standard', 'data_export', 'true'),
  ('professional', 'documents', '20'),
  ('professional', 'storage_mb', '200'),
  ('professional', 'otp_gate', 'true'),
  ('professional', 'data_export', 'true');
