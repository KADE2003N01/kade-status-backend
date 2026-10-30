CREATE TABLE user_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_data_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE recruiter_otps (
  id INTEGER PRIMARY KEY,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  requests INTEGER NOT NULL DEFAULT 1,
  request_window_started_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (portfolio_id, email_hash)
);

CREATE TABLE recruiter_sessions (
  token_hash TEXT PRIMARY KEY,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'verified' CHECK (state IN ('verified', 'contact_completed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  contact_completed_at INTEGER
);
CREATE INDEX idx_recruiter_sessions_portfolio ON recruiter_sessions(portfolio_id, expires_at);

CREATE TABLE recruiter_contacts (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  email_enc TEXT NOT NULL,
  position_enc TEXT NOT NULL,
  phone_enc TEXT NOT NULL,
  reason_enc TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recruiter_contacts_owner ON recruiter_contacts(owner_user_id, created_at DESC);
CREATE INDEX idx_recruiter_contacts_portfolio ON recruiter_contacts(portfolio_id, created_at DESC);
