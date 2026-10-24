import express from 'express';
import database from '../../database/database.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';

const router = express.Router();
const MAX_REPLY_LENGTH = 3000;

router.get('/', (req, res) => {
  const unreadCount = database.prepare("SELECT COUNT(*) AS count FROM contact_messages WHERE status = 'new' AND deleted_at IS NULL").get().count;
  const conversations = database.prepare(`SELECT id, name, email, phone, message, created_at AS createdAt, status
    FROM contact_messages WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 500`).all();
  const findReplies = database.prepare(`SELECT reply.id, reply.body, reply.created_at AS createdAt, admin.display_name AS adminName, admin.email AS adminEmail
    FROM contact_message_replies reply LEFT JOIN admin_users admin ON admin.id = reply.admin_user_id
    WHERE reply.contact_message_id = ? ORDER BY reply.created_at, reply.id`);
  const results = conversations.map((conversation) => ({ ...conversation, replies: findReplies.all(conversation.id) }));
  return res.json({ success: true, conversations: results, unreadCount });
});

router.post('/:messageId/replies', async (req, res) => {
  const messageId = Number(req.params.messageId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid visitor message.' });
  if (!body || body.length > MAX_REPLY_LENGTH) return res.status(400).json({ success: false, error: 'Enter a reply from 1 to 3,000 characters.' });
  const conversation = database.prepare('SELECT id, name, email, message FROM contact_messages WHERE id = ? AND deleted_at IS NULL').get(messageId);
  if (!conversation) return res.status(404).json({ success: false, error: 'Visitor message not found.' });

  let transporter;
  try { transporter = getTransporter('contact'); }
  catch { return res.status(503).json({ success: false, error: 'Contact email is not configured for replies.' }); }
  if (!transporter) return res.status(503).json({ success: false, error: 'Contact email is not configured for replies.' });

  try {
    const from = getMailFromAddress('contact');
    await transporter.sendMail({
      from,
      to: conversation.email,
      replyTo: req.adminUser.email,
      subject: `Re: Your message to ${process.env.ADMIN_DISPLAY_NAME || 'the portfolio owner'}`,
      text: `Hi ${conversation.name},\n\n${body}\n\n--- Your message ---\n${conversation.message}\n\nReply directly to this email to continue the conversation.`
    });
  } catch (error) {
    console.error('Visitor message reply could not be delivered:', error.code || error.message);
    return res.status(503).json({ success: false, error: 'The reply could not be delivered. Check the contact email settings and try again.' });
  }

  const result = database.prepare(`INSERT INTO contact_message_replies (contact_message_id, admin_user_id, body)
    VALUES (?, ?, ?)` ).run(messageId, req.adminUser.id, body);
  database.prepare("UPDATE contact_messages SET status = 'open' WHERE id = ?").run(messageId);
  return res.status(201).json({ success: true, reply: { id: result.lastInsertRowid, body, createdAt: new Date().toISOString(), adminName: req.adminUser.display_name, adminEmail: req.adminUser.email } });
});

router.patch('/:messageId/status', (req, res) => {
  const messageId = Number(req.params.messageId);
  const status = req.body?.status;
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !['open', 'resolved'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Choose a valid visitor message and status.' });
  }
  const result = database.prepare('UPDATE contact_messages SET status = ? WHERE id = ? AND deleted_at IS NULL').run(status, messageId);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Visitor message not found.' });
  return res.json({ success: true, status });
});

router.delete('/:messageId', (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid visitor message.' });
  const result = database.prepare('UPDATE contact_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run(messageId);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Visitor message not found.' });
  return res.json({ success: true, message: 'Visitor message removed from the inbox.' });
});

export default router;
