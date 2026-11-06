CREATE TABLE platform_plan_account_pages (
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free', 'standard', 'professional')),
  page_id TEXT NOT NULL CHECK (page_id IN (
    'overview', 'profile', 'security', 'subscription', 'benefits',
    'chat', 'settings', 'support', 'support-chat', 'gallery'
  )),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id, page_id)
);

INSERT INTO platform_plan_account_pages (plan_id, page_id, enabled) VALUES
  ('free', 'overview', 1),
  ('free', 'profile', 1),
  ('free', 'security', 1),
  ('free', 'subscription', 1),
  ('free', 'benefits', 1),
  ('free', 'chat', 0),
  ('free', 'settings', 1),
  ('free', 'support', 1),
  ('free', 'support-chat', 0),
  ('free', 'gallery', 0),
  ('standard', 'overview', 1),
  ('standard', 'profile', 1),
  ('standard', 'security', 1),
  ('standard', 'subscription', 1),
  ('standard', 'benefits', 1),
  ('standard', 'chat', 0),
  ('standard', 'settings', 1),
  ('standard', 'support', 1),
  ('standard', 'support-chat', 0),
  ('standard', 'gallery', 1),
  ('professional', 'overview', 1),
  ('professional', 'profile', 1),
  ('professional', 'security', 1),
  ('professional', 'subscription', 1),
  ('professional', 'benefits', 1),
  ('professional', 'chat', 1),
  ('professional', 'settings', 1),
  ('professional', 'support', 1),
  ('professional', 'support-chat', 1),
  ('professional', 'gallery', 1);
