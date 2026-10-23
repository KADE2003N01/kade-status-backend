import express from 'express';
import database from '../../database/database.js';
import { requireAdmin } from '../../verification/admin-auth.js';

const router = express.Router();
router.use(requireAdmin);

function isPlatformOwner(user) {
  return (user.roles || [user.role]).includes('platform_owner');
}

function ensureThread(adminId, replyAllowed = true) {
  let thread = database.prepare('SELECT id, reply_allowed AS replyAllowed FROM platform_message_threads WHERE admin_user_id = ?').get(adminId);
  if (!thread) {
    const created = database.prepare('INSERT INTO platform_message_threads (admin_user_id, reply_allowed) VALUES (?, ?)').run(adminId, replyAllowed ? 1 : 0);
    thread = { id: created.lastInsertRowid, replyAllowed: replyAllowed ? 1 : 0 };
  }
  return thread;
}

function unreadCount(user) {
  const owner = isPlatformOwner(user);
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
  const owner = isPlatformOwner(req.adminUser);
  const threads = owner
    ? database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        admin.status AS adminStatus, thread.reply_allowed AS replyAllowed, thread.updated_at AS updatedAt
        FROM admin_users admin LEFT JOIN platform_message_threads thread ON thread.admin_user_id = admin.id
        WHERE admin.role <> 'platform_owner' ORDER BY COALESCE(thread.updated_at, admin.created_at) DESC`)
      .all().map((thread) => ({ ...thread, replyAllowed: Boolean(thread.replyAllowed) }))
    : database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        admin.status AS adminStatus, thread.reply_allowed AS replyAllowed, thread.updated_at AS updatedAt
        FROM admin_users admin LEFT JOIN platform_message_threads thread ON thread.admin_user_id = admin.id
        WHERE admin.id = ?`).all(req.adminUser.id).map((thread) => ({ ...thread, replyAllowed: thread.id ? Boolean(thread.replyAllowed) : true }));

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

router.patch('/threads/:threadId/replies', (req, res) => {
  if (!isPlatformOwner(req.adminUser)) return res.status(403).json({ success: false, error: 'Only a super-admin can change reply access.' });
  const threadId = Number(req.params.threadId);
  if (!Number.isSafeInteger(threadId) || threadId < 1 || typeof req.body?.allowed !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Choose a valid conversation and reply setting.' });
  }
  const result = database.prepare('UPDATE platform_message_threads SET reply_allowed = ? WHERE id = ?').run(req.body.allowed ? 1 : 0, threadId);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  return res.json({ success: true, allowed: req.body.allowed });
});

router.post('/', (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1 || body.length > 3000) return res.status(400).json({ success: false, error: 'Message must be between 1 and 3,000 characters.' });
  const owner = isPlatformOwner(req.adminUser);

  if (!owner) {
    const thread = ensureThread(req.adminUser.id);
    if (!thread.replyAllowed) return res.status(403).json({ success: false, code: 'REPLIES_DISABLED', error: 'Replies are currently disabled for this conversation.' });
    const result = database.prepare('INSERT INTO platform_messages (thread_id, sender_id, body) VALUES (?, ?, ?)')
      .run(thread.id, req.adminUser.id, body);
    database.prepare('UPDATE platform_message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
    return res.status(201).json({ success: true, message: { id: result.lastInsertRowid, threadId: thread.id, senderId: req.adminUser.id,
      senderName: req.adminUser.display_name, senderEmail: req.adminUser.email, senderRole: req.adminUser.role, body, createdAt: new Date().toISOString(), isRead: true } });
  }

  const all = req.body?.all === true;
  const replyAllowed = req.body?.allowReplies !== false;
  let recipients;
  if (all) {
    recipients = database.prepare("SELECT id FROM admin_users WHERE role <> 'platform_owner' AND status = 'active' ORDER BY id").all();
  } else {
    const requestedIds = Array.isArray(req.body?.adminIds) ? req.body.adminIds.map(Number) : [Number(req.body?.adminId)];
    const ids = [...new Set(requestedIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length || ids.length > 100) return res.status(400).json({ success: false, error: 'Choose one or more valid admin recipients.' });
    const placeholders = ids.map(() => '?').join(',');
    recipients = database.prepare(`SELECT id FROM admin_users WHERE id IN (${placeholders}) AND role <> 'platform_owner' AND status = 'active'`).all(...ids);
    if (recipients.length !== ids.length) return res.status(400).json({ success: false, error: 'One or more recipients are missing, inactive, or are super-admin accounts.' });
  }
  if (!recipients.length) return res.status(409).json({ success: false, error: 'There are no active customer admins to receive this message.' });

  const created = database.transaction(() => recipients.map(({ id: adminId }) => {
    const thread = ensureThread(adminId, replyAllowed);
    database.prepare('UPDATE platform_message_threads SET reply_allowed = ? WHERE id = ?').run(replyAllowed ? 1 : 0, thread.id);
    const result = database.prepare('INSERT INTO platform_messages (thread_id, sender_id, body) VALUES (?, ?, ?)')
      .run(thread.id, req.adminUser.id, body);
    database.prepare('UPDATE platform_message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
    return { id: result.lastInsertRowid, threadId: thread.id, adminId };
  }))();
  return res.status(201).json({ success: true, sent: created.length, message: all
    ? `Message sent to ${created.length} active admin${created.length === 1 ? '' : 's'}.`
    : `Message sent to ${created.length} admin${created.length === 1 ? '' : 's'}.` });
});

export default router;
