import express from 'express';
import database from '../../database/database.js';
import { requirePlatformOwner } from '../../verification/admin-auth.js';

const router = express.Router();
router.use(...requirePlatformOwner);

router.get('/customer-chat', (req, res) => {
  const customers = database.prepare(`SELECT u.id, u.display_name AS displayName, u.email,
    (SELECT body FROM customer_support_messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS lastMessage,
    (SELECT created_at FROM customer_support_messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS lastMessageAt,
    (SELECT COUNT(*) FROM customer_support_messages m WHERE m.user_id = u.id AND m.sender_role = 'customer' AND m.read_at IS NULL) AS unreadCount
    FROM users u WHERE u.role = 'customer' AND EXISTS (SELECT 1 FROM customer_support_messages m WHERE m.user_id = u.id)
    ORDER BY lastMessageAt DESC, u.id`).all();
  return res.json({ success: true, customers });
});

router.get('/customer-chat/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ success: false, error: 'Invalid customer.' });
  const customer = database.prepare("SELECT id, display_name AS displayName, email FROM users WHERE id = ? AND role = 'customer'").get(userId);
  if (!customer) return res.status(404).json({ success: false, error: 'Customer not found.' });
  const messages = database.prepare('SELECT id, sender_role AS senderRole, body, created_at AS createdAt FROM customer_support_messages WHERE user_id = ? ORDER BY id').all(userId);
  database.prepare("UPDATE customer_support_messages SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND sender_role = 'customer' AND read_at IS NULL").run(userId);
  return res.json({ success: true, customer, messages });
});

router.post('/customer-chat/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ success: false, error: 'Invalid customer.' });
  if (body.length < 1 || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters.' });
  const customer = database.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(userId);
  if (!customer) return res.status(404).json({ success: false, error: 'Customer not found.' });
  const result = database.prepare("INSERT INTO customer_support_messages (user_id, sender_role, body) VALUES (?, 'platform_owner', ?)").run(userId, body);
  const message = database.prepare('SELECT id, sender_role AS senderRole, body, created_at AS createdAt FROM customer_support_messages WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json({ success: true, message });
});

export default router;
