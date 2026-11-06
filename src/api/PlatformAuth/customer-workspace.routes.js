import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import database from '../../database/database.js';
import { resolveWritablePath } from '../../config/storage.js';
import { requirePlatformUser } from '../../verification/platform-auth.js';
import { requireAccountPage } from '../../services/account-page-access.js';
import { getCustomerSupportMessages } from '../../services/customer-support-chat.js';

const router = express.Router();
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const messageAttachmentTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/flac',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);
const messageReactions = new Set(['👍', '❤️', '😂', '😮', '🙏', '😢', '😡', '🎉', '🔥', '👏', '👀', '✅']);
router.use(requirePlatformUser);
router.use((req, res, next) => req.platformUser.role === 'customer'
  ? next() : res.status(403).json({ success: false, error: 'Customer account required.' }));

router.get('/gallery', requireAccountPage(database, 'gallery'), (req, res) => {
  const files = database.prepare(`SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS size, created_at AS createdAt
    FROM customer_gallery_files WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(req.platformUser.id);
  return res.json({ success: true, files });
});

router.post('/gallery', requireAccountPage(database, 'gallery'), express.raw({ type: '*/*', limit: MAX_FILE_SIZE }), async (req, res, next) => {
  try {
    const buffer = req.body;
    const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const originalName = decodeURIComponent(String(req.query.name || 'upload').slice(0, 240)).replace(/[\\/\0]/g, '_');
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_SIZE) return res.status(400).json({ success: false, error: 'Choose a file up to 20 MB.' });
    if (!allowedTypes.has(mimeType)) return res.status(400).json({ success: false, error: 'Gallery accepts JPG, PNG, GIF, WebP, and PDF files.' });
    const signatureOk = mimeType === 'image/jpeg' ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mimeType === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === 'image/gif' ? buffer.subarray(0, 4).toString('ascii') === 'GIF8'
          : mimeType === 'image/webp' ? buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
            : buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    if (!signatureOk) return res.status(400).json({ success: false, error: 'The file contents do not match its file type.' });
    const id = randomUUID();
    const extension = path.extname(originalName).slice(0, 12) || (mimeType === 'application/pdf' ? '.pdf' : `.${mimeType.split('/')[1]}`);
    const storedName = `${id}${extension}`;
    await writeFile(resolveWritablePath('customer-gallery', storedName), buffer, { flag: 'wx' });
    database.prepare(`INSERT INTO customer_gallery_files (id, user_id, original_name, stored_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.platformUser.id, originalName, storedName, mimeType, buffer.length);
    return res.status(201).json({ success: true, file: { id, name: originalName, mimeType, size: buffer.length, createdAt: new Date().toISOString() } });
  } catch (error) { return next(error); }
});

router.get('/gallery/:id', requireAccountPage(database, 'gallery'), (req, res, next) => {
  const file = database.prepare('SELECT stored_name, mime_type, original_name FROM customer_gallery_files WHERE id = ? AND user_id = ?').get(req.params.id, req.platformUser.id);
  if (!file) return res.status(404).json({ success: false, error: 'File not found.' });
  res.type(file.mime_type).setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  return createReadStream(resolveWritablePath('customer-gallery', file.stored_name)).on('error', next).pipe(res);
});

router.delete('/gallery/:id', requireAccountPage(database, 'gallery'), async (req, res, next) => {
  try {
    const file = database.prepare('SELECT stored_name FROM customer_gallery_files WHERE id = ? AND user_id = ?').get(req.params.id, req.platformUser.id);
    if (!file) return res.status(404).json({ success: false, error: 'File not found.' });
    database.prepare('DELETE FROM customer_gallery_files WHERE id = ? AND user_id = ?').run(req.params.id, req.platformUser.id);
    await unlink(resolveWritablePath('customer-gallery', file.stored_name)).catch(() => {});
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

function loadCustomerChat(req, res) {
  database.prepare(`UPDATE customer_support_messages SET read_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND sender_role = 'platform_owner' AND read_at IS NULL`).run(req.platformUser.id);
  return res.json({
    success: true,
    messages: getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat')
  });
}

function isValidMessageFile(mimeType, buffer) {
  if (mimeType.startsWith('text/')) return !buffer.includes(0);
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType.startsWith('video/') || mimeType === 'audio/mp4') return buffer.subarray(4, 8).toString('ascii') === 'ftyp' || (mimeType === 'video/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  if (mimeType === 'audio/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'audio/ogg') return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/flac') return buffer.subarray(0, 4).toString('ascii') === 'fLaC';
  if (mimeType === 'audio/aac') return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/mpeg') return buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/zip' || mimeType.includes('openxmlformats')) return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (mimeType.startsWith('application/ms') || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.ms-powerpoint') return buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return false;
}

async function uploadCustomerChatAttachment(req, res, next) {
  try {
    const buffer = req.body;
    const mimeType = String(req.headers['x-file-type'] || req.headers['content-type'] || '').split(';')[0].toLowerCase();
    let originalName;
    try { originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'attachment')); }
    catch { return res.status(400).json({ success: false, error: 'The attachment filename is invalid.' }); }
    originalName = path.basename(originalName).replace(/[\\/\0]/g, '_').slice(0, 240) || 'attachment';
    const attachmentTotals = database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size
      FROM customer_support_message_attachments WHERE user_id = ? AND message_id IS NULL`).get(req.platformUser.id);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CHAT_FILE_SIZE) return res.status(400).json({ success: false, error: 'Choose a file up to 50 MB.' });
    if (attachmentTotals.count >= 10 || attachmentTotals.size + buffer.length > 100 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Pending attachments must be at most 10 files and 100 MB total.' });
    if (!messageAttachmentTypes.has(mimeType) || !isValidMessageFile(mimeType, buffer)) return res.status(400).json({ success: false, error: 'The attachment contents do not match a supported file type.' });
    const id = randomUUID();
    const extension = path.extname(originalName).slice(0, 12) || '.bin';
    const storedName = `${id}${extension}`;
    const filePath = resolveWritablePath('customer-support-attachments', storedName);
    await writeFile(filePath, buffer, { flag: 'wx' });
    try {
      database.prepare(`INSERT INTO customer_support_message_attachments
        (id, user_id, original_name, stored_name, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.platformUser.id, originalName, storedName, mimeType, buffer.length);
    } catch (error) {
      await unlink(filePath).catch(() => {});
      throw error;
    }
    return res.status(201).json({ success: true, attachment: { id, name: originalName, mimeType, size: buffer.length } });
  } catch (error) { return next(error); }
}

function sendCustomerChat(req, res) {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const attachmentIds = [...new Set(Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [])];
  const replyToMessageId = req.body?.replyToMessageId === undefined ? null : Number(req.body.replyToMessageId);
  if ((!body && !attachmentIds.length) || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters or attach a file.' });
  if (attachmentIds.length > 10 || attachmentIds.some((id) => typeof id !== 'string')) return res.status(400).json({ success: false, error: 'Attach up to 10 files to one message.' });
  if (replyToMessageId !== null && (!Number.isSafeInteger(replyToMessageId) || !database.prepare('SELECT id FROM customer_support_messages WHERE id = ? AND user_id = ?').get(replyToMessageId, req.platformUser.id))) {
    return res.status(400).json({ success: false, error: 'The message you are replying to could not be found.' });
  }
  const attachments = attachmentIds.length
    ? database.prepare(`SELECT id FROM customer_support_message_attachments
        WHERE user_id = ? AND message_id IS NULL AND id IN (${attachmentIds.map(() => '?').join(', ')})`).all(req.platformUser.id, ...attachmentIds)
    : [];
  if (attachments.length !== attachmentIds.length) return res.status(400).json({ success: false, error: 'One or more attachments are no longer available. Please add them again.' });
  const messageId = database.transaction(() => {
    const inserted = database.prepare(`INSERT INTO customer_support_messages
      (user_id, sender_role, body, reply_to_message_id) VALUES (?, 'customer', ?, ?)`)
      .run(req.platformUser.id, body, replyToMessageId);
    if (attachmentIds.length) database.prepare(`UPDATE customer_support_message_attachments SET message_id = ?
      WHERE user_id = ? AND id IN (${attachmentIds.map(() => '?').join(', ')})`)
      .run(inserted.lastInsertRowid, req.platformUser.id, ...attachmentIds);
    return inserted.lastInsertRowid;
  })();
  const messages = getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat');
  return res.status(201).json({ success: true, message: messages.find((message) => message.id === messageId) });
}

router.get('/chat', requireAccountPage(database, 'chat'), loadCustomerChat);
router.post('/chat', requireAccountPage(database, 'chat'), sendCustomerChat);
router.get('/support-chat', requireAccountPage(database, 'support-chat'), loadCustomerChat);
router.post('/support-chat/attachments', requireAccountPage(database, 'support-chat'), express.raw({ type: '*/*', limit: MAX_CHAT_FILE_SIZE }), uploadCustomerChatAttachment);
router.get('/support-chat/attachments/:id', requireAccountPage(database, 'support-chat'), (req, res, next) => {
  const attachment = database.prepare(`SELECT stored_name AS storedName, original_name AS name, mime_type AS mimeType
    FROM customer_support_message_attachments WHERE id = ? AND user_id = ? AND message_id IS NOT NULL`).get(req.params.id, req.platformUser.id);
  if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found.' });
  res.type(attachment.mimeType).setHeader('Content-Disposition', `${attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('audio/') || attachment.mimeType.startsWith('video/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return createReadStream(resolveWritablePath('customer-support-attachments', attachment.storedName)).on('error', next).pipe(res);
});
router.delete('/support-chat/attachments/:id', requireAccountPage(database, 'support-chat'), async (req, res, next) => {
  try {
    const attachment = database.prepare(`SELECT stored_name AS storedName FROM customer_support_message_attachments
      WHERE id = ? AND user_id = ? AND message_id IS NULL`).get(req.params.id, req.platformUser.id);
    if (!attachment) return res.status(404).json({ success: false, error: 'Unused attachment not found.' });
    database.prepare('DELETE FROM customer_support_message_attachments WHERE id = ?').run(req.params.id);
    await unlink(resolveWritablePath('customer-support-attachments', attachment.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return res.json({ success: true });
  } catch (error) { return next(error); }
});
router.post('/support-chat', requireAccountPage(database, 'support-chat'), sendCustomerChat);
router.patch('/support-chat/:id', requireAccountPage(database, 'support-chat'), (req, res) => {
  const messageId = Number(req.params.id);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(messageId) || !body || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters.' });
  const updated = database.prepare(`UPDATE customer_support_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND sender_role = 'customer' AND deleted_at IS NULL`).run(body, messageId, req.platformUser.id);
  if (!updated.changes) return res.status(404).json({ success: false, error: 'Your message could not be found or edited.' });
  const messages = getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat');
  return res.json({ success: true, message: messages.find((message) => message.id === messageId) });
});
router.delete('/support-chat/:id', requireAccountPage(database, 'support-chat'), async (req, res, next) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isSafeInteger(messageId)) return res.status(400).json({ success: false, error: 'Invalid message.' });
    const message = database.prepare(`SELECT id FROM customer_support_messages
      WHERE id = ? AND user_id = ? AND sender_role = 'customer' AND deleted_at IS NULL`).get(messageId, req.platformUser.id);
    if (!message) return res.status(404).json({ success: false, error: 'Your message could not be found or deleted.' });
    const attachments = database.prepare(`SELECT stored_name AS storedName FROM customer_support_message_attachments
      WHERE message_id = ? AND user_id = ?`).all(messageId, req.platformUser.id);
    database.prepare(`UPDATE customer_support_messages SET body = '', deleted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND sender_role = 'customer'`).run(messageId, req.platformUser.id);
    database.prepare('DELETE FROM customer_support_message_attachments WHERE message_id = ? AND user_id = ?').run(messageId, req.platformUser.id);
    for (const attachment of attachments) await unlink(resolveWritablePath('customer-support-attachments', attachment.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const messages = getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat');
    return res.json({ success: true, message: messages.find((item) => item.id === messageId) });
  } catch (error) { return next(error); }
});
router.post('/support-chat/:id/reactions', requireAccountPage(database, 'support-chat'), (req, res) => {
  const messageId = Number(req.params.id);
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  if (!Number.isSafeInteger(messageId) || !messageReactions.has(emoji)) return res.status(400).json({ success: false, error: 'Choose a supported reaction.' });
  const message = database.prepare(`SELECT id FROM customer_support_messages
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(messageId, req.platformUser.id);
  if (!message) return res.status(404).json({ success: false, error: 'Message not found.' });
  const existing = database.prepare(`SELECT message_id FROM customer_support_message_reactions
    WHERE message_id = ? AND actor_role = 'customer' AND actor_id = ? AND emoji = ?`).get(messageId, req.platformUser.id, emoji);
  if (existing) {
    database.prepare(`DELETE FROM customer_support_message_reactions
      WHERE message_id = ? AND actor_role = 'customer' AND actor_id = ? AND emoji = ?`).run(messageId, req.platformUser.id, emoji);
  } else {
    database.prepare(`INSERT INTO customer_support_message_reactions (message_id, actor_role, actor_id, emoji)
      VALUES (?, 'customer', ?, ?)`).run(messageId, req.platformUser.id, emoji);
  }
  const messages = getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat');
  return res.json({ success: true, reactions: messages.find((item) => item.id === messageId)?.reactions || [] });
});
router.post('/support-chat/:id/flags', requireAccountPage(database, 'support-chat'), (req, res) => {
  const messageId = Number(req.params.id);
  const flag = typeof req.body?.flag === 'string' ? req.body.flag : '';
  if (!Number.isSafeInteger(messageId) || !['pin', 'star'].includes(flag) || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Choose a valid message flag.' });
  if (!database.prepare('SELECT id FROM customer_support_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(messageId, req.platformUser.id)) return res.status(404).json({ success: false, error: 'Message not found.' });
  if (req.body.enabled) {
    database.prepare(`INSERT OR IGNORE INTO customer_support_message_flags (message_id, actor_role, actor_id, flag)
      VALUES (?, 'customer', ?, ?)`).run(messageId, req.platformUser.id, flag);
  } else {
    database.prepare(`DELETE FROM customer_support_message_flags
      WHERE message_id = ? AND actor_role = 'customer' AND actor_id = ? AND flag = ?`).run(messageId, req.platformUser.id, flag);
  }
  const message = getCustomerSupportMessages(database, req.platformUser.id, 'customer', req.platformUser.id, '/customer-workspace/support-chat')
    .find((item) => item.id === messageId);
  return res.json({ success: true, isPinned: message.isPinned, isStarred: message.isStarred });
});

export default router;
