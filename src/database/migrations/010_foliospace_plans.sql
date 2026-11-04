-- FolioSpace plan feature catalog (spacePlan limits) + demo subscriptions.
-- Payment is not connected yet, so Standard and Professional are granted as
-- active demo subscriptions; the gates below are enforced against this record.
INSERT INTO plans (id, name, price_minor, currency, active)
VALUES ('standard', 'Standard', 10000, 'RWF', 1),
  ('professional', 'Professional', 15000, 'RWF', 1) ON CONFLICT(id) DO
UPDATE
SET name = excluded.name,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  active = excluded.active;
INSERT INTO plan_features (plan_id, feature_key, value_json)
VALUES ('free', 'folio_max_spaces', '1'),
  (
    'free',
    'folio_sections',
    '["hero","about","skills","contact"]'
  ),
  ('free', 'folio_templates', '["classic"]'),
  ('free', 'folio_watermark', 'true'),
  ('standard', 'folio_max_spaces', '3'),
  (
    'standard',
    'folio_sections',
    '["hero","about","skills","contact","experience","education","projects"]'
  ),
  (
    'standard',
    'folio_templates',
    '["classic","studio"]'
  ),
  ('standard', 'folio_watermark', 'false'),
  ('standard', 'folio_custom_colors', 'true'),
  ('standard', 'folio_visitor_stats', 'true'),
  ('standard', 'folio_private_sections', 'true'),
  ('standard', 'folio_subdomain', 'true'),
  ('professional', 'folio_max_spaces', '-1'),
  (
    'professional',
    'folio_sections',
    '["hero","about","skills","contact","experience","education","projects","certificates","video_pitch"]'
  ),
  (
    'professional',
    'folio_templates',
    '["classic","studio","executive"]'
  ),
  ('professional', 'folio_watermark', 'false'),
  ('professional', 'folio_custom_colors', 'true'),
  ('professional', 'folio_visitor_stats', 'true'),
  ('professional', 'folio_private_sections', 'true'),
  ('professional', 'folio_subdomain', 'true'),
  ('professional', 'folio_custom_domain', 'true'),
  ('professional', 'folio_seo_controls', 'true'),
  ('professional', 'folio_pdf_export', 'true'),
  ('professional', 'folio_qr_code', 'true'),
  (
    'professional',
    'folio_priority_placement',
    'true'
  ),
  ('professional', 'folio_branding', 'true') ON CONFLICT(plan_id, feature_key) DO
UPDATE
SET value_json = excluded.value_json;
-- Demo subscriptions: give every existing account without a paid plan an active
-- Standard subscription so the full plan features can be demoed without payment.
-- Remove these rows when a real payment provider is wired up.
INSERT INTO subscriptions (user_id, plan_id, state, period_end, updated_at)
SELECT u.id,
  'standard',
  'active',
  datetime('now', '+6 months'),
  CURRENT_TIMESTAMP
FROM users u
WHERE NOT EXISTS (
    SELECT 1
    FROM subscriptions s
    WHERE s.user_id = u.id
      AND s.plan_id IN ('standard', 'professional')
  ) ON CONFLICT(user_id) DO
UPDATE
SET plan_id = 'standard',
  state = 'active',
  period_end = datetime('now', '+6 months'),
  updated_at = CURRENT_TIMESTAMP
WHERE subscriptions.plan_id = 'free';
-- Sync the signup-time template choice into the subscription plan where no
-- explicit demo upgrade was made above.
UPDATE subscriptions
SET plan_id = (
    SELECT po.selected_template_id
    FROM platform_onboarding po
    WHERE po.user_id = subscriptions.user_id
  ),
  state = CASE
    WHEN (
      SELECT po.selected_template_id
      FROM platform_onboarding po
      WHERE po.user_id = subscriptions.user_id
    ) = 'free' THEN 'free'
    ELSE 'active'
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE plan_id = 'free'
  AND EXISTS (
    SELECT 1
    FROM platform_onboarding po
    WHERE po.user_id = subscriptions.user_id
      AND po.selected_template_id IN ('standard', 'professional')
  );