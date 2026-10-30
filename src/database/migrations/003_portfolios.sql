CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  template_id TEXT NOT NULL DEFAULT 'minimal_grid' CHECK (template_id = 'minimal_grid'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_portfolios_owner ON portfolios(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_sections (
  id INTEGER PRIMARY KEY,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'hero', 'about', 'experience', 'education', 'projects',
    'skills', 'certificates', 'video_pitch', 'contact'
  )),
  sort_order INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (portfolio_id, type)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_sections_public ON portfolio_sections(portfolio_id, is_private, sort_order);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'RWF',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (plan_id, feature_key)
);

INSERT OR IGNORE INTO plans (id, name, price_minor, currency, active) VALUES
  ('free', 'Free', 0, 'RWF', 1),
  ('professional', 'Professional', 0, 'RWF', 0);

INSERT OR IGNORE INTO plan_features (plan_id, feature_key, value_json) VALUES
  ('free', 'documents', '3'),
  ('free', 'storage_mb', '10'),
  ('free', 'otp_gate', 'true'),
  ('free', 'data_export', 'true'),
  ('professional', 'documents', '20'),
  ('professional', 'storage_mb', '200'),
  ('professional', 'otp_gate', 'true'),
  ('professional', 'data_export', 'true');

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL DEFAULT 'free' REFERENCES plans(id),
  state TEXT NOT NULL DEFAULT 'free' CHECK (state IN ('free', 'active', 'grace', 'paused', 'cancelled')),
  period_end TEXT,
  grace_end TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS create_free_subscription
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO subscriptions (user_id, plan_id, state)
  VALUES (NEW.id, 'free', 'free');
END;

INSERT INTO subscriptions (user_id, plan_id, state)
SELECT id, 'free', 'free' FROM users
WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.user_id = users.id);
