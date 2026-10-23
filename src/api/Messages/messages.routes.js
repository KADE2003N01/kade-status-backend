import express from 'express';
import database from '../../database/database.js';
import { requireAdmin } from '../../verification/admin-auth.js';

const router = express.Router();
router.use(requireAdmin);

function unreadCount(user) {
  const owner = user.role === 'platform_owner';
  return database.prepare(`SELECT COUNT(*) AS count
    FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE ${owner ? "sender.role <> 'platform_owner'" : "sender.role = 'platform_owner' AND thread.admin_user_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM platform_message_reads read_state WHERE read_state.message_id = message.id AND read_state.reader_id = ?)`)
    .get(...(owner ? [user.id] : [user.id, user.id])).count;
}

router.get('/unread-count', (req, res) => res.json({ success: true, count: unreadCount(req.adminUser) }));

router.get('/', (req, res) => {
  const owner = req.adminUser.role === 'platform_owner';
  const threads = owner
    ? database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        thread.updated_at AS updatedAt FROM platform_message_threads thread JOIN admin_users admin ON admin.id = thread.admin_user_id
        ORDER BY thread.updated_at DESC`).all()
    : database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        thread.updated_at AS updatedAt FROM platform_message_threads thread JOIN admin_users admin ON admin.id = thread.admin_user_id
        WHERE thread.admin_user_id = ?`).all(req.adminUser.id);
  const rows = owner
    ? database.prepare(`SELECT message.id, message.thread_id AS threadId, message.sender_id AS senderId, sender.display_name AS senderName,
        sender.email AS senderEmail, sender.role AS senderRole, message.body, message.created_at AS createdAt,
        EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?) AS isRead
        FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        LEFT JOIN admin_users sender ON sender.id = message.sender_id ORDER BY message.created_at, message.id`).all(req.adminUser.id)
    : database.prepare(`SELECT message.id, message.thread_id AS threadId, message.sender_id AS senderId, sender.display_name AS senderName,
        sender.email AS senderEmail, sender.role AS senderRole, message.body, message.created_at AS createdAt,
        EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?) AS isRead
        FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        LEFT JOIN admin_users sender ON sender.id = message.sender_id WHERE thread.admin_user_id = ? ORDER BY message.created_at, message.id`)
      .all(req.adminUser.id, req.adminUser.id);

  const ownerIncoming = owner ? "sender.role <> 'platform_owner'" : "sender.role = 'platform_owner'";
  database.prepare(`INSERT OR IGNORE INTO platform_message_reads (message_id, reader_id)
    SELECT message.id, ? FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE ${ownerIncoming} ${owner ? '' : 'AND thread.admin_user_id = ?'}`)
    .run(...(owner ? [req.adminUser.id] : [req.adminUser.id, req.adminUser.id]));
  return res.json({ success: true, threads, messages: rows, unreadCount: unreadCount(req.adminUser) });
});

router.post('/', (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1 || body.length > 3000) return res.status(400).json({ success: false, error: 'Message must be between 1 and 3,000 characters.' });
  const owner = req.adminUser.role === 'platform_owner';
  let adminId = req.adminUser.id;
  if (owner) {
    adminId = Number(req.body?.adminId);
    const admin = database.prepare("SELECT id FROM admin_users WHERE id = ? AND role <> 'platform_owner'").get(adminId);
    if (!Number.isSafeInteger(adminId) || !admin) return res.status(400).json({ success: false, error: 'Choose a valid administrator conversation.' });
  }
  let thread = database.prepare('SELECT id FROM platform_message_threads WHERE admin_user_id = ?').get(adminId);
  if (!thread) {
    const created = database.prepare('INSERT INTO platform_message_threads (admin_user_id) VALUES (?)').run(adminId);
    thread = { id: created.lastInsertRowid };
  }
  const result = database.prepare('INSERT INTO platform_messages (thread_id, sender_id, body) VALUES (?, ?, ?)')
    .run(thread.id, req.adminUser.id, body);
  database.prepare('UPDATE platform_message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
  return res.status(201).json({ success: true, message: { id: result.lastInsertRowid, threadId: thread.id, senderId: req.adminUser.id,
    senderName: req.adminUser.display_name, senderEmail: req.adminUser.email, senderRole: req.adminUser.role, body, createdAt: new Date().toISOString(), isRead: true } });
});

export default router;
