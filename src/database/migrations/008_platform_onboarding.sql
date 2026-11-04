CREATE TABLE IF NOT EXISTS platform_onboarding (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_template_id TEXT NOT NULL DEFAULT 'free'
    CHECK (selected_template_id IN ('free', 'standard', 'professional')),
  currency TEXT NOT NULL DEFAULT 'RWF'
    CHECK (currency IN ('RWF', 'USD')),
  stage TEXT NOT NULL DEFAULT 'space_setup'
    CHECK (stage IN ('subscription', 'space_setup', 'complete')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'not_required', 'bypassed', 'paid')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
