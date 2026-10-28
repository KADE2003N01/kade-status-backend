import express from 'express';
import database from '../../database/database.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';

const router = express.Router();
const MAX_REPLY_LENGTH = 3000;
const allowedReactions = new Set(['👍', '❤️', '😂', '😮', '🙏']);

function contactReactions(contactMessageIds, replyIds, readerId) {
  const reactions = new Map();
  const addRows = (rows, keyPrefix) => rows.forEach((row) => {
    const key = `${keyPrefix}${row.targetId}`;
    if (!reactions.has(key)) reactions.set(key, []);
    const summary = reactions.get(key);
    let reaction = summary.find((item) => item.emoji === row.emoji);
    if (!reaction) {
      reaction = { emoji: row.emoji, count: 0, reacted: false };
      summary.push(reaction);
    }
    reaction.count += 1;
    if (Number(row.reactorId) === Number(readerId)) reaction.reacted = true;
  });
  if (contactMessageIds.length) {
    const ids = contactMessageIds.map(() => '?').join(',');
    addRows(database.prepare(`SELECT contact_message_id AS targetId, emoji, reactor_id AS reactorId
      FROM contact_message_reactions WHERE contact_message_id IN (${ids}) ORDER BY created_at`)
      .all(...contactMessageIds), 'contact:');
  }
  if (replyIds.length) {
    const ids = replyIds.map(() => '?').join(',');
    addRows(database.prepare(`SELECT reply_id AS targetId, emoji, reactor_id AS reactorId
      FROM contact_message_reactions WHERE reply_id IN (${ids}) ORDER BY created_at`)
      .all(...replyIds), 'reply:');
  }
  return reactions;
}

function addContactReactions(conversations, readerId) {
  const rootIds = conversations.map((item) => item.id);
  const replyIds = conversations.flatMap((item) => item.replies.map((reply) => reply.id));
  const reactions = contactReactions(rootIds, replyIds, readerId);
  return conversations.map((item) => ({
    ...item,
    reactions: reactions.get(`contact:${item.id}`) || [],
    replies: item.replies.map((reply) => ({ ...reply, reactions: reactions.get(`reply:${reply.id}`) || [] }))
  }));
}

router.get('/', (req, res) => {
  const unreadCount = database.prepare(`SELECT COUNT(*) AS count FROM contact_messages message
    WHERE message.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM contact_message_reads state WHERE state.contact_message_id = message.id AND state.reader_id = ?
    )`).get(req.adminUser.id).count;
  const conversations = database.prepare(`SELECT id, name, email, phone, message, created_at AS createdAt, status,
      EXISTS (SELECT 1 FROM contact_message_reads state WHERE state.contact_message_id = contact_messages.id AND state.reader_id = ?) AS isRead
    FROM contact_messages WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 500`).all(req.adminUser.id);
  const findReplies = database.prepare(`SELECT reply.id, reply.body, reply.created_at AS createdAt, admin.display_name AS adminName, admin.email AS adminEmail
    FROM contact_message_replies reply LEFT JOIN admin_users admin ON admin.id = reply.admin_user_id
    WHERE reply.contact_message_id = ? ORDER BY reply.created_at, reply.id`);
  const results = conversations.map((conversation) => ({ ...conversation, replies: findReplies.all(conversation.id) }));
  return res.json({ success: true, conversations: addContactReactions(results, req.adminUser.id), unreadCount });
});

router.post('/:messageId/read', (req, res) => {
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid visitor message.' });
  const result = database.prepare(`INSERT OR IGNORE INTO contact_message_reads (contact_message_id, reader_id)
    SELECT id, ? FROM contact_messages WHERE id = ? AND deleted_at IS NULL`).run(req.adminUser.id, messageId);
  if (!result.changes && !database.prepare('SELECT 1 FROM contact_messages WHERE id = ? AND deleted_at IS NULL').get(messageId)) {
    return res.status(404).json({ success: false, error: 'Visitor message not found.' });
  }
  return res.json({ success: true, read: true });
});

router.post('/:messageId/reactions', (req, res) => {
  const messageId = Number(req.params.messageId);
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !allowedReactions.has(emoji)) {
    return res.status(400).json({ success: false, error: 'Choose a valid message and reaction.' });
  }
  if (!database.prepare('SELECT 1 FROM contact_messages WHERE id = ? AND deleted_at IS NULL').get(messageId)) {
    return res.status(404).json({ success: false, error: 'Visitor message not found.' });
  }
  const existing = database.prepare(`SELECT 1 FROM contact_message_reactions
    WHERE contact_message_id = ? AND reactor_id = ? AND emoji = ?`).get(messageId, req.adminUser.id, emoji);
  if (existing) database.prepare(`DELETE FROM contact_message_reactions
    WHERE contact_message_id = ? AND reactor_id = ? AND emoji = ?`).run(messageId, req.adminUser.id, emoji);
  else database.prepare(`INSERT INTO contact_message_reactions (contact_message_id, reactor_id, emoji)
    VALUES (?, ?, ?)`).run(messageId, req.adminUser.id, emoji);
  return res.json({ success: true, reactions: contactReactions([messageId], [], req.adminUser.id).get(`contact:${messageId}`) || [] });
});

router.post('/:messageId/replies/:replyId/reactions', (req, res) => {
  const messageId = Number(req.params.messageId);
  const replyId = Number(req.params.replyId);
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !Number.isSafeInteger(replyId) || replyId < 1 || !allowedReactions.has(emoji)) {
    return res.status(400).json({ success: false, error: 'Choose a valid message and reaction.' });
  }
  if (!database.prepare(`SELECT 1 FROM contact_message_replies WHERE id = ? AND contact_message_id = ?
    AND EXISTS (SELECT 1 FROM contact_messages WHERE id = ? AND deleted_at IS NULL)`).get(replyId, messageId, messageId)) {
    return res.status(404).json({ success: false, error: 'Visitor reply not found.' });
  }
  const existing = database.prepare(`SELECT 1 FROM contact_message_reactions
    WHERE reply_id = ? AND reactor_id = ? AND emoji = ?`).get(replyId, req.adminUser.id, emoji);
  if (existing) database.prepare(`DELETE FROM contact_message_reactions
    WHERE reply_id = ? AND reactor_id = ? AND emoji = ?`).run(replyId, req.adminUser.id, emoji);
  else database.prepare(`INSERT INTO contact_message_reactions (reply_id, reactor_id, emoji)
    VALUES (?, ?, ?)`).run(replyId, req.adminUser.id, emoji);
  return res.json({ success: true, reactions: contactReactions([], [replyId], req.adminUser.id).get(`reply:${replyId}`) || [] });
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

router.patch('/:messageId/replies/:replyId', (req, res) => {
  const messageId = Number(req.params.messageId);
  const replyId = Number(req.params.replyId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !Number.isSafeInteger(replyId) || replyId < 1) {
    return res.status(400).json({ success: false, error: 'Choose a valid visitor reply.' });
  }
  if (!body || body.length > MAX_REPLY_LENGTH) return res.status(400).json({ success: false, error: 'Enter a reply from 1 to 3,000 characters.' });
  const result = database.prepare(`UPDATE contact_message_replies SET body = ?
    WHERE id = ? AND contact_message_id = ? AND admin_user_id = ?
      AND EXISTS (SELECT 1 FROM contact_messages WHERE id = ? AND deleted_at IS NULL)`)
    .run(body, replyId, messageId, req.adminUser.id, messageId);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Your saved reply could not be found.' });
  return res.json({ success: true, reply: { id: replyId, body } });
});

router.delete('/:messageId/replies/:replyId', (req, res) => {
  const messageId = Number(req.params.messageId);
  const replyId = Number(req.params.replyId);
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !Number.isSafeInteger(replyId) || replyId < 1) {
    return res.status(400).json({ success: false, error: 'Choose a valid visitor reply.' });
  }
  const result = database.prepare(`DELETE FROM contact_message_replies
    WHERE id = ? AND contact_message_id = ? AND admin_user_id = ?
      AND EXISTS (SELECT 1 FROM contact_messages WHERE id = ? AND deleted_at IS NULL)`)
    .run(replyId, messageId, req.adminUser.id, messageId);
  if (!result.changes) return res.status(404).json({ success: false, error: 'Your saved reply could not be found.' });
  return res.json({ success: true, message: 'Your saved reply was deleted for all admins. The sent email cannot be recalled.' });
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
