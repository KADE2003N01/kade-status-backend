import express from 'express';
import database from '../../database/database.js';

const router = express.Router();
const recentSubmissions = new Map();

router.post('/', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (recentSubmissions.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);
  if (recent.length >= 4) return res.status(429).json({ success: false, error: 'Too many support requests. Please try again later.' });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const categories = new Set(['sign_in', 'inactive_account', 'password_reset', 'setup_link', 'other']);
  if (name.length < 2 || name.length > 120) return res.status(400).json({ success: false, error: 'Enter a name from 2 to 120 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  if (!categories.has(category)) return res.status(400).json({ success: false, error: 'Choose a support request type.' });
  if (message.length < 10 || message.length > 3000) return res.status(400).json({ success: false, error: 'Describe the issue in 10 to 3,000 characters.' });

  const user = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
  const result = database.prepare(`INSERT INTO admin_support_requests (admin_user_id, name, email, category, message)
    VALUES (?, ?, ?, ?, ?)`).run(user?.id || null, name, email, category, message);
  database.prepare('INSERT INTO platform_admin_audit (actor_id, action, details_json) VALUES (?, ?, ?)')
    .run(user?.id || null, 'admin_support_request_created', JSON.stringify({ requestId: result.lastInsertRowid, email, category }));
  recent.push(now);
  recentSubmissions.set(ip, recent);
  return res.status(201).json({ success: true, requestId: result.lastInsertRowid, message: 'Your support request was sent to the platform owner.' });
});

export default router;
