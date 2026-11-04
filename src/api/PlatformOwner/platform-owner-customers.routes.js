// Platform-owner controls for FolioSpace customer accounts (the `users` table).
// Owners can list customers, activate/suspend them, change their subscription
// plan behind the scenes (the demo path to upgrade/downgrade without payment),
// and permanently delete them. Every action is written to the audit log.
import express from 'express';
import database from '../../database/database.js';

const router = express.Router();

function audit(actorId, action, details = {}) {
  database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
    .run(actorId, action, JSON.stringify(details));
}

const customerSelect = `
  SELECT users.id, users.email, users.display_name AS displayName, users.role,
    users.status, users.email_verified_at AS emailVerifiedAt,
    users.created_at AS createdAt, users.updated_at AS updatedAt,
    subscriptions.plan_id AS planId, subscriptions.state AS planState,
    subscriptions.period_end AS periodEnd,
    (SELECT COUNT(*) FROM portfolios WHERE portfolios.owner_user_id = users.id) AS portfolioCount
  FROM users
  LEFT JOIN subscriptions ON subscriptions.user_id = users.id
`;

const PLAN_IDS = new Set(['free', 'standard', 'professional']);

router.get('/customers', (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
  const status = ['active', 'pending_verification', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const conditions = ["users.role = 'customer'"];
  const parameters = [];
  if (search) {
    conditions.push('(users.display_name LIKE ? COLLATE NOCASE OR users.email LIKE ? COLLATE NOCASE)');
    parameters.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    conditions.push('users.status = ?');
    parameters.push(status);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageSize = 50;
  const total = database.prepare(`SELECT COUNT(*) AS total FROM users ${where}`).get(...parameters).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number(req.query.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
  const counts = database.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN users.status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN users.status = 'pending_verification' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN users.status = 'suspended' THEN 1 ELSE 0 END), 0) AS suspended
    FROM users WHERE users.role = 'customer'
  `).get();
  const planCounts = database.prepare(`
    SELECT COALESCE(s.plan_id, 'free') AS planId, COUNT(*) AS count
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.role = 'customer' GROUP BY COALESCE(s.plan_id, 'free')
  `).all().reduce((accumulator, row) => ({ ...accumulator, [row.planId]: row.count }), {});
  const customers = database.prepare(`${customerSelect} ${where} ORDER BY users.created_at DESC, users.id DESC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize);
  return res.json({ success: true, customers, page, pageSize, total, totalPages, counts, planCounts });
});

router.patch('/customers/:customerId/status', (req, res) => {
  const id = Number(req.params.customerId);
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!Number.isSafeInteger(id) || id < 1 || !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Choose a valid customer account status.' });
  }
  const target = database.prepare("SELECT id, email, display_name, status FROM users WHERE id = ? AND role = 'customer'").get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Customer account not found.' });
  if (target.status === 'pending_verification' && status === 'active') {
    return res.status(409).json({ success: false, error: 'This customer has not verified their email yet. They must verify before activation.' });
  }
  database.transaction(() => {
    database.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    if (status === 'suspended') {
      // End every session so a suspended customer loses access immediately.
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  })();
  audit(req.adminUser.id, status === 'active' ? 'customer_activated' : 'customer_suspended', { customerId: id, email: target.email });
  return res.json({ success: true, message: `Customer account ${status === 'active' ? 'activated' : 'suspended'}.` });
});

router.patch('/customers/:customerId/plan', (req, res) => {
  const id = Number(req.params.customerId);
  const planId = typeof req.body?.planId === 'string' ? req.body.planId : '';
  if (!Number.isSafeInteger(id) || id < 1 || !PLAN_IDS.has(planId)) {
    return res.status(400).json({ success: false, error: 'Choose a valid subscription plan.' });
  }
  const target = database.prepare("SELECT id, email FROM users WHERE id = ? AND role = 'customer'").get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Customer account not found.' });
  database.prepare(`
    INSERT INTO subscriptions (user_id, plan_id, state, period_end, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      state = excluded.state,
      period_end = excluded.period_end,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, planId, planId === 'free' ? 'free' : 'active', planId === 'free' ? null : new Date(Date.now() + 182 * 24 * 60 * 60 * 1000).toISOString());
  audit(req.adminUser.id, 'customer_plan_changed', { customerId: id, email: target.email, planId });
  return res.json({ success: true, message: `Subscription plan set to ${planId}.` });
});

router.delete('/customers/:customerId', (req, res) => {
  const id = Number(req.params.customerId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid customer account.' });
  const target = database.prepare("SELECT id, email, display_name FROM users WHERE id = ? AND role = 'customer'").get(id);
  if (!target) return res.status(404).json({ success: false, error: 'Customer account not found.' });
  const portfolioCount = database.prepare('SELECT COUNT(*) AS count FROM portfolios WHERE owner_user_id = ?').get(id).count;
  // Permanently removes the customer and, by cascade, their portfolios,
  // sections, sessions, and subscription.
  database.transaction(() => {
    audit(req.adminUser.id, 'customer_deleted', {
      customerId: id, email: target.email, displayName: target.display_name, portfolioCount
    });
    database.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  return res.json({
    success: true,
    message: `Customer ${target.email} deleted${portfolioCount ? ` along with ${portfolioCount} portfolio${portfolioCount === 1 ? '' : 's'}` : ''}.`
  });
});

export default router;
