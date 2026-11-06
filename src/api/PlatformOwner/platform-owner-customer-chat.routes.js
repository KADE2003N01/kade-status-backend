import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import database from '../../database/database.js';
import { resolveWritablePath } from '../../config/storage.js';
import { requirePlatformOwner } from '../../verification/admin-auth.js';
import { CUSTOMER_SUPPORT_ATTACHMENT_TYPES, CUSTOMER_SUPPORT_REACTIONS, getCustomerSupportMessages, isValidCustomerSupportFile } from '../../services/customer-support-chat.js';

const router = express.Router();
const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024;
router.use(...requirePlatformOwner);

function validCustomerId(value) {
  const userId = Number(value);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

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
  const userId = validCustomerId(req.params.userId);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid customer.' });
  const customer = database.prepare("SELECT id, display_name AS displayName, email FROM users WHERE id = ? AND role = 'customer'").get(userId);
  if (!customer) return res.status(404).json({ success: false, error: 'Customer not found.' });
  database.prepare("UPDATE customer_support_messages SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND sender_role = 'customer' AND read_at IS NULL").run(userId);
  const messages = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`);
  return res.json({ success: true, customer, messages });
});

router.post('/customer-chat/:userId/attachments', express.raw({ type: '*/*', limit: MAX_CHAT_FILE_SIZE }), async (req, res, next) => {
  try {
    const userId = validCustomerId(req.params.userId);
    if (!userId) return res.status(400).json({ success: false, error: 'Invalid customer.' });
    if (!database.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(userId)) return res.status(404).json({ success: false, error: 'Customer not found.' });
    const buffer = req.body;
    const mimeType = String(req.headers['x-file-type'] || req.headers['content-type'] || '').split(';')[0].toLowerCase();
    let originalName;
    try { originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'attachment')); }
    catch { return res.status(400).json({ success: false, error: 'The attachment filename is invalid.' }); }
    originalName = path.basename(originalName).replace(/[\\/\0]/g, '_').slice(0, 240) || 'attachment';
    const totals = database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size
      FROM customer_support_message_attachments WHERE user_id = ? AND message_id IS NULL`).get(userId);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CHAT_FILE_SIZE) return res.status(400).json({ success: false, error: 'Choose a file up to 50 MB.' });
    if (totals.count >= 10 || totals.size + buffer.length > 100 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Pending attachments must be at most 10 files and 100 MB total.' });
    if (!CUSTOMER_SUPPORT_ATTACHMENT_TYPES.has(mimeType) || !isValidCustomerSupportFile(mimeType, buffer)) return res.status(400).json({ success: false, error: 'The attachment contents do not match a supported file type.' });
    const id = randomUUID();
    const storedName = `${id}${path.extname(originalName).slice(0, 12) || '.bin'}`;
    const filePath = resolveWritablePath('customer-support-attachments', storedName);
    await writeFile(filePath, buffer, { flag: 'wx' });
    try {
      database.prepare(`INSERT INTO customer_support_message_attachments
        (id, user_id, original_name, stored_name, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, originalName, storedName, mimeType, buffer.length);
    } catch (error) {
      await unlink(filePath).catch(() => {});
      throw error;
    }
    return res.status(201).json({ success: true, attachment: { id, name: originalName, mimeType, size: buffer.length } });
  } catch (error) { return next(error); }
});

router.get('/customer-chat/:userId/attachments/:attachmentId', (req, res, next) => {
  const userId = validCustomerId(req.params.userId);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid customer.' });
  const attachment = database.prepare(`SELECT stored_name AS storedName, original_name AS name, mime_type AS mimeType
    FROM customer_support_message_attachments WHERE id = ? AND user_id = ? AND message_id IS NOT NULL`)
    .get(req.params.attachmentId, userId);
  if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found.' });
  res.type(attachment.mimeType).setHeader('Content-Disposition', `${attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('audio/') || attachment.mimeType.startsWith('video/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return createReadStream(resolveWritablePath('customer-support-attachments', attachment.storedName)).on('error', next).pipe(res);
});

router.delete('/customer-chat/:userId/attachments/:attachmentId', async (req, res, next) => {
  try {
    const userId = validCustomerId(req.params.userId);
    if (!userId) return res.status(400).json({ success: false, error: 'Invalid customer.' });
    const attachment = database.prepare(`SELECT stored_name AS storedName FROM customer_support_message_attachments
      WHERE id = ? AND user_id = ? AND message_id IS NULL`).get(req.params.attachmentId, userId);
    if (!attachment) return res.status(404).json({ success: false, error: 'Unused attachment not found.' });
    database.prepare('DELETE FROM customer_support_message_attachments WHERE id = ?').run(req.params.attachmentId);
    await unlink(resolveWritablePath('customer-support-attachments', attachment.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

router.post('/customer-chat/:userId', (req, res) => {
  const userId = validCustomerId(req.params.userId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const attachmentIds = [...new Set(Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [])];
  const replyToMessageId = req.body?.replyToMessageId === undefined ? null : Number(req.body.replyToMessageId);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid customer.' });
  if ((!body && !attachmentIds.length) || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters or attach a file.' });
  if (attachmentIds.length > 10 || attachmentIds.some((id) => typeof id !== 'string')) return res.status(400).json({ success: false, error: 'Attach up to 10 files to one message.' });
  if (replyToMessageId !== null && (!Number.isSafeInteger(replyToMessageId) || !database.prepare('SELECT id FROM customer_support_messages WHERE id = ? AND user_id = ?').get(replyToMessageId, userId))) return res.status(400).json({ success: false, error: 'The message you are replying to could not be found.' });
  const customer = database.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(userId);
  if (!customer) return res.status(404).json({ success: false, error: 'Customer not found.' });
  const availableAttachments = attachmentIds.length
    ? database.prepare(`SELECT id FROM customer_support_message_attachments
        WHERE user_id = ? AND message_id IS NULL AND id IN (${attachmentIds.map(() => '?').join(', ')})`).all(userId, ...attachmentIds)
    : [];
  if (availableAttachments.length !== attachmentIds.length) return res.status(400).json({ success: false, error: 'One or more attachments are no longer available. Please add them again.' });
  const messageId = database.transaction(() => {
    const inserted = database.prepare(`INSERT INTO customer_support_messages
      (user_id, sender_role, body, reply_to_message_id) VALUES (?, 'platform_owner', ?, ?)`)
      .run(userId, body, replyToMessageId);
    if (attachmentIds.length) database.prepare(`UPDATE customer_support_message_attachments SET message_id = ?
      WHERE user_id = ? AND id IN (${attachmentIds.map(() => '?').join(', ')})`)
      .run(inserted.lastInsertRowid, userId, ...attachmentIds);
    return inserted.lastInsertRowid;
  })();
  const message = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`).find((item) => item.id === messageId);
  return res.status(201).json({ success: true, message });
});

router.patch('/customer-chat/:userId/:messageId', (req, res) => {
  const userId = validCustomerId(req.params.userId);
  const messageId = Number(req.params.messageId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!userId || !Number.isSafeInteger(messageId)) return res.status(400).json({ success: false, error: 'Invalid customer message.' });
  if (!body || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters.' });
  const updated = database.prepare(`UPDATE customer_support_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND sender_role = 'platform_owner' AND deleted_at IS NULL`).run(body, messageId, userId);
  if (!updated.changes) return res.status(404).json({ success: false, error: 'The owner message could not be found or edited.' });
  const message = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`).find((item) => item.id === messageId);
  return res.json({ success: true, message });
});

router.delete('/customer-chat/:userId/:messageId', async (req, res, next) => {
  try {
    const userId = validCustomerId(req.params.userId);
    const messageId = Number(req.params.messageId);
    if (!userId || !Number.isSafeInteger(messageId)) return res.status(400).json({ success: false, error: 'Invalid customer message.' });
    const message = database.prepare(`SELECT id FROM customer_support_messages
      WHERE id = ? AND user_id = ? AND sender_role = 'platform_owner' AND deleted_at IS NULL`).get(messageId, userId);
    if (!message) return res.status(404).json({ success: false, error: 'The owner message could not be found or deleted.' });
    const attachments = database.prepare(`SELECT stored_name AS storedName FROM customer_support_message_attachments
      WHERE message_id = ? AND user_id = ?`).all(messageId, userId);
    database.prepare(`UPDATE customer_support_messages SET body = '', deleted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND sender_role = 'platform_owner'`).run(messageId, userId);
    database.prepare('DELETE FROM customer_support_message_attachments WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    for (const attachment of attachments) await unlink(resolveWritablePath('customer-support-attachments', attachment.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const deletedMessage = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`).find((item) => item.id === messageId);
    return res.json({ success: true, message: deletedMessage });
  } catch (error) { return next(error); }
});

router.post('/customer-chat/:userId/:messageId/reactions', (req, res) => {
  const userId = validCustomerId(req.params.userId);
  const messageId = Number(req.params.messageId);
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  if (!userId || !Number.isSafeInteger(messageId) || !CUSTOMER_SUPPORT_REACTIONS.has(emoji)) return res.status(400).json({ success: false, error: 'Choose a supported reaction.' });
  if (!database.prepare('SELECT id FROM customer_support_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(messageId, userId)) return res.status(404).json({ success: false, error: 'Message not found.' });
  const existing = database.prepare(`SELECT message_id FROM customer_support_message_reactions
    WHERE message_id = ? AND actor_role = 'platform_owner' AND actor_id = ? AND emoji = ?`).get(messageId, req.adminUser.id, emoji);
  if (existing) database.prepare(`DELETE FROM customer_support_message_reactions
    WHERE message_id = ? AND actor_role = 'platform_owner' AND actor_id = ? AND emoji = ?`).run(messageId, req.adminUser.id, emoji);
  else database.prepare(`INSERT INTO customer_support_message_reactions (message_id, actor_role, actor_id, emoji)
    VALUES (?, 'platform_owner', ?, ?)`).run(messageId, req.adminUser.id, emoji);
  const message = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`).find((item) => item.id === messageId);
  return res.json({ success: true, reactions: message?.reactions || [] });
});

router.post('/customer-chat/:userId/:messageId/flags', (req, res) => {
  const userId = validCustomerId(req.params.userId);
  const messageId = Number(req.params.messageId);
  const flag = typeof req.body?.flag === 'string' ? req.body.flag : '';
  if (!userId || !Number.isSafeInteger(messageId) || !['pin', 'star'].includes(flag) || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Choose a valid message flag.' });
  if (!database.prepare('SELECT id FROM customer_support_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(messageId, userId)) return res.status(404).json({ success: false, error: 'Message not found.' });
  if (req.body.enabled) {
    database.prepare(`INSERT OR IGNORE INTO customer_support_message_flags (message_id, actor_role, actor_id, flag)
      VALUES (?, 'platform_owner', ?, ?)`).run(messageId, req.adminUser.id, flag);
  } else {
    database.prepare(`DELETE FROM customer_support_message_flags
      WHERE message_id = ? AND actor_role = 'platform_owner' AND actor_id = ? AND flag = ?`).run(messageId, req.adminUser.id, flag);
  }
  const message = getCustomerSupportMessages(database, userId, 'platform_owner', req.adminUser.id, `/platform-owner/customer-chat/${userId}`).find((item) => item.id === messageId);
  return res.json({ success: true, isPinned: message.isPinned, isStarred: message.isStarred });
});

export default router;
