import express from 'express';
import database from '../../database/database.js';

const router = express.Router();
const recentSubmissions = new Map();

router.post('/', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (recentSubmissions.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const requestedRoles = [...new Set(Array.isArray(req.body?.roles) ? req.body.roles : [])];
  const categories = new Set(['sign_in', 'inactive_account', 'password_reset', 'setup_link', 'admin_invitation', 'other']);
  const standardRoles = new Set(['portfolio_owner', 'content_manager', 'document_manager', 'download_manager', 'profile_manager']);
  if (name.length < 2 || name.length > 120) return res.status(400).json({ success: false, error: 'Enter a name from 2 to 120 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  if (!categories.has(category)) return res.status(400).json({ success: false, error: 'Choose a support request type.' });
  if (category === 'admin_invitation' && (!requestedRoles.length || requestedRoles.some((role) => !standardRoles.has(role)))) {
    return res.status(400).json({ success: false, error: 'Choose one or more available admin roles. Super-admin access is not available through this request.' });
  }
  if (category !== 'admin_invitation' && requestedRoles.length) return res.status(400).json({ success: false, error: 'Roles can only be selected for a new admin account request.' });
  if (message.length < 10 || message.length > 3000) return res.status(400).json({ success: false, error: 'Describe the issue in 10 to 3,000 characters.' });

  const duplicate = database.prepare(`SELECT id FROM admin_support_requests
    WHERE email = ? COLLATE NOCASE AND category = ? AND status = 'open'
    ORDER BY id DESC LIMIT 1`).get(email, category);
  if (duplicate) return res.json({ success: true, alreadySent: true, requestId: duplicate.id, message: 'Your Ticket was already sent. The platform owner can see your open request; please wait for an update.' });
  if (recent.length >= 4) return res.status(429).json({ success: false, error: 'Too many support requests. Please try again later.' });

  const user = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
  const result = database.prepare(`INSERT INTO admin_support_requests (admin_user_id, name, email, category, message, requested_roles_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(user?.id || null, name, email, category, message, JSON.stringify(requestedRoles));
  database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
    .run(user?.id || null, 'admin_support_request_created', JSON.stringify({ requestId: result.lastInsertRowid, email, category, ...(category === 'admin_invitation' ? { requestedRoles } : {}) }));
  recent.push(now);
  recentSubmissions.set(ip, recent);
  return res.status(201).json({ success: true, requestId: result.lastInsertRowid, message: 'Your ticket was raised successfully and sent to the platform owner.' });
});

export default router;
