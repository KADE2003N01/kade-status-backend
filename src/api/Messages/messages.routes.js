import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import database from '../../database/database.js';
import { resolveWritablePath } from '../../config/storage.js';
import { requireAdmin } from '../../verification/admin-auth.js';
import visitorMessagesRouter from './visitor-messages.routes.js';

const router = express.Router();
router.use(requireAdmin);
router.use('/visitors', visitorMessagesRouter);
const MESSAGE_FILE_LIMIT = 50 * 1024 * 1024;
const MESSAGE_TOTAL_ATTACHMENT_LIMIT = 100 * 1024 * 1024;
const attachmentTypes = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/flac': '.flac',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/zip': '.zip',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
};

function attachmentSignatureMatches(mimeType, buffer) {
  const starts = (...bytes) => bytes.every((byte, index) => buffer[index] === byte);
  if (mimeType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mimeType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === 'image/gif') return buffer.subarray(0, 6).toString('ascii').startsWith('GIF8');
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType.startsWith('video/') || mimeType === 'audio/mp4') return buffer.subarray(4, 8).toString('ascii') === 'ftyp' || (mimeType === 'video/webm' && starts(0x1a, 0x45, 0xdf, 0xa3));
  if (mimeType === 'audio/webm') return starts(0x1a, 0x45, 0xdf, 0xa3);
  if (mimeType === 'audio/ogg') return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/flac') return buffer.subarray(0, 4).toString('ascii') === 'fLaC';
  if (mimeType === 'audio/aac') return starts(0xff) && (buffer[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/mpeg') return buffer.subarray(0, 3).toString('ascii') === 'ID3' || (starts(0xff) && (buffer[1] & 0xe0) === 0xe0);
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/zip' || mimeType.includes('openxmlformats')) return starts(0x50, 0x4b, 0x03, 0x04);
  if (mimeType.startsWith('application/ms') || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.ms-powerpoint') return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  if (mimeType.startsWith('text/')) return !buffer.includes(0);
  return false;
}

function attachmentInfo(row) {
  return { id: row.id, name: row.original_name, mimeType: row.mime_type, size: row.size_bytes, url: `/messages/attachments/${row.id}` };
}

async function removeUnreferencedFiles(names) {
  for (const name of new Set(names)) {
    const count = database.prepare('SELECT COUNT(*) AS count FROM platform_message_attachments WHERE stored_name = ?').get(name).count;
    if (count) continue;
    try { await unlink(resolveWritablePath('message-attachments', name)); } catch { /* The file may already have been removed. */ }
  }
}

async function cleanupExpiredAttachments() {
  const stale = database.prepare(`SELECT id, stored_name AS storedName FROM platform_message_attachments
    WHERE message_id IS NULL AND message_group_id IS NULL AND created_at < datetime('now', '-24 hours')`).all();
  if (!stale.length) return;
  const remove = database.prepare('DELETE FROM platform_message_attachments WHERE id = ? AND message_id IS NULL AND message_group_id IS NULL');
  stale.forEach((row) => remove.run(row.id));
  await removeUnreferencedFiles(stale.map((row) => row.storedName));
}

cleanupExpiredAttachments().catch(() => {});
const attachmentCleanupTimer = setInterval(() => cleanupExpiredAttachments().catch(() => {}), 60 * 60 * 1000);
attachmentCleanupTimer.unref?.();

async function clearMessagesPermanently(messageIds, ownerId) {
  const cleared = database.transaction(() => {
    const find = database.prepare(`SELECT id, message_group_id AS messageGroupId FROM platform_messages WHERE id = ? AND sender_id = ?
      AND EXISTS (SELECT 1 FROM admin_users sender WHERE sender.id = platform_messages.sender_id AND sender.role = 'platform_owner')`);
    const findGroupFiles = database.prepare('SELECT stored_name FROM platform_message_attachments WHERE message_group_id = ?');
    const findMessageFiles = database.prepare('SELECT stored_name FROM platform_message_attachments WHERE message_id = ?');
    const deleteGroupFiles = database.prepare('DELETE FROM platform_message_attachments WHERE message_group_id = ?');
    const deleteMessageFiles = database.prepare('DELETE FROM platform_message_attachments WHERE message_id = ?');
    const deleteGroup = database.prepare('DELETE FROM platform_messages WHERE sender_id = ? AND message_group_id = ?');
    const deleteOne = database.prepare('DELETE FROM platform_messages WHERE id = ? AND sender_id = ?');
    const visited = new Set();
    const storedNames = [];
    let count = 0;
    for (const id of messageIds) {
      const message = find.get(id, ownerId);
      if (!message) continue;
      const key = message.messageGroupId || `message:${message.id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (message.messageGroupId) {
        storedNames.push(...findGroupFiles.all(message.messageGroupId).map((row) => row.stored_name));
        deleteGroupFiles.run(message.messageGroupId);
        count += deleteGroup.run(ownerId, message.messageGroupId).changes;
      } else {
        storedNames.push(...findMessageFiles.all(message.id).map((row) => row.stored_name));
        deleteMessageFiles.run(message.id);
        count += deleteOne.run(message.id, ownerId).changes;
      }
    }
    return { count, storedNames };
  })();
  await removeUnreferencedFiles(cleared.storedNames);
  return cleared.count;
}

function attachmentRowsForMessages(rows) {
  const find = database.prepare(`SELECT id, original_name, mime_type, size_bytes FROM platform_message_attachments
    WHERE message_id = ? OR (message_group_id IS NOT NULL AND message_group_id = ?) ORDER BY created_at, id`);
  return rows.map((message) => ({ ...message, attachments: find.all(message.id, message.messageGroupId || '').map(attachmentInfo) }));
}

router.post('/attachments', express.raw({ type: 'application/octet-stream', limit: MESSAGE_FILE_LIMIT }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ success: false, error: 'Choose a file to attach.' });
  const mimeType = String(req.get('X-File-Type') || '').toLowerCase().split(';')[0].trim();
  const extension = attachmentTypes[mimeType];
  if (!extension) return res.status(415).json({ success: false, error: 'This file type is not supported.' });
  if (req.body.length > MESSAGE_FILE_LIMIT) return res.status(413).json({ success: false, error: 'Each attachment must be 50 MB or smaller.' });
  if (!attachmentSignatureMatches(mimeType, req.body)) return res.status(415).json({ success: false, error: 'The file contents do not match the selected file type.' });
  let originalName = String(req.get('X-File-Name') || 'attachment');
  try { originalName = decodeURIComponent(originalName); } catch { /* Keep the supplied name and sanitize it below. */ }
  originalName = path.basename(originalName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')).slice(0, 180) || `attachment${extension}`;
  const id = randomUUID();
  const storedName = `${id}${extension}`;
  try {
    await writeFile(resolveWritablePath('message-attachments', storedName), req.body, { flag: 'wx' });
    database.prepare(`INSERT INTO platform_message_attachments (id, uploaded_by_id, original_name, mime_type, size_bytes, stored_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.adminUser.id, originalName, mimeType, req.body.length, storedName);
    return res.status(201).json({ success: true, attachment: { id, name: originalName, mimeType, size: req.body.length } });
  } catch {
    try { await unlink(resolveWritablePath('message-attachments', storedName)); } catch { /* Ignore cleanup failure. */ }
    return res.status(500).json({ success: false, error: 'The attachment could not be stored.' });
  }
});

router.get('/attachments/:attachmentId', async (req, res) => {
  const rows = database.prepare(`SELECT attachment.*, message.deleted_at AS deletedAt, thread.admin_user_id AS adminId
    FROM platform_message_attachments attachment
    LEFT JOIN platform_messages message ON message.id = attachment.message_id
      OR (attachment.message_group_id IS NOT NULL AND message.message_group_id = attachment.message_group_id)
    LEFT JOIN platform_message_threads thread ON thread.id = message.thread_id
    WHERE attachment.id = ?`).all(req.params.attachmentId);
  const owner = isPlatformOwner(req.adminUser);
  const attachment = rows.find((row) => owner
    ? row.message_id !== null || row.message_group_id !== null
    : Number(row.adminId) === Number(req.adminUser.id) && !row.deletedAt);
  if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found.' });
  const filePath = resolveWritablePath('message-attachments', attachment.stored_name);
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader('Content-Length', attachment.size_bytes);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  const inline = attachment.mime_type.startsWith('image/') || attachment.mime_type.startsWith('audio/') || attachment.mime_type.startsWith('video/');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
  const stream = createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ success: false, error: 'Attachment file is missing.' }); else res.destroy(); });
  stream.pipe(res);
});

router.delete('/attachments/:attachmentId', async (req, res) => {
  const row = database.prepare(`SELECT id, stored_name FROM platform_message_attachments
    WHERE id = ? AND uploaded_by_id = ? AND message_id IS NULL AND message_group_id IS NULL`).get(req.params.attachmentId, req.adminUser.id);
  if (!row) return res.status(404).json({ success: false, error: 'Unused attachment not found.' });
  database.prepare('DELETE FROM platform_message_attachments WHERE id = ?').run(row.id);
  await removeUnreferencedFiles([row.stored_name]);
  return res.json({ success: true });
});

function isPlatformOwner(user) {
  return (user.roles || [user.role]).includes('platform_owner');
}

function isAdminWorkspace(req) {
  return isPlatformOwner(req.adminUser) && req.query.workspace === 'admin';
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
  return database.prepare(`SELECT COUNT(*) AS count
    FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE message.deleted_at IS NULL AND sender.id <> ? AND COALESCE(message.recipient_owner_id, thread.admin_user_id) = ?
      AND NOT EXISTS (SELECT 1 FROM platform_message_reads read_state WHERE read_state.message_id = message.id AND read_state.reader_id = ?)
      AND NOT EXISTS (SELECT 1 FROM platform_message_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?)`)
    .get(user.id, user.id, user.id, user.id, user.id).count;
}

router.get('/unread-count', (req, res) => {
  const owner = isPlatformOwner(req.adminUser);
  const adminWorkspace = isAdminWorkspace(req);
  const visitorCount = owner && !adminWorkspace ? 0 : database.prepare("SELECT COUNT(*) AS count FROM contact_messages WHERE status = 'new' AND deleted_at IS NULL").get().count;
  if (adminWorkspace) {
    const directUnread = database.prepare(`SELECT COUNT(*) AS count FROM platform_messages message
      JOIN platform_message_threads thread ON thread.id = message.thread_id
      JOIN admin_users sender ON sender.id = message.sender_id
      WHERE sender.role = 'platform_owner' AND sender.id <> ? AND message.deleted_at IS NULL
        AND (thread.admin_user_id = ? OR message.recipient_owner_id = ?)
        AND NOT EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?)
        AND NOT EXISTS (SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?)`)
      .get(req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id).count;
    return res.json({ success: true, count: directUnread + visitorCount, visitorCount });
  }
  return res.json({ success: true, count: unreadCount(req.adminUser) + visitorCount, visitorCount });
});

router.get('/super-admins', (req, res) => {
  const admins = database.prepare(`SELECT owner.id, owner.display_name AS displayName, owner.email, owner.status AS adminStatus,
      COALESCE(access.reply_allowed, thread.reply_allowed, 1) AS replyAllowed
    FROM admin_users owner
    LEFT JOIN platform_message_threads thread ON thread.admin_user_id = ?
    LEFT JOIN platform_message_owner_reply_access access ON access.admin_user_id = ? AND access.owner_user_id = owner.id
    WHERE (owner.role = 'platform_owner' OR EXISTS (SELECT 1 FROM json_each(owner.roles_json) WHERE value = 'platform_owner')) AND owner.id <> ? ORDER BY CASE owner.status WHEN 'active' THEN 0 ELSE 1 END, owner.display_name COLLATE NOCASE, owner.id`).all(req.adminUser.id, req.adminUser.id, req.adminUser.id)
    .map((admin) => ({ ...admin, replyAllowed: Boolean(admin.replyAllowed) }));
  return res.json({ success: true, admins });
});

router.get('/', (req, res) => {
  const owner = isPlatformOwner(req.adminUser);
  const adminWorkspace = isAdminWorkspace(req);
  if (adminWorkspace) ensureThread(req.adminUser.id);
  const threads = owner && !adminWorkspace
    ? database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        admin.status AS adminStatus, admin.role AS adminRole, admin.roles_json AS adminRolesJson, COALESCE(access.reply_allowed, thread.reply_allowed, 1) AS replyAllowed, thread.updated_at AS updatedAt,
        (SELECT MAX(message.created_at) FROM platform_messages message WHERE message.thread_id = thread.id) AS latestMessageAt
        FROM admin_users admin LEFT JOIN platform_message_threads thread ON thread.admin_user_id = admin.id
        LEFT JOIN platform_message_owner_reply_access access ON access.admin_user_id = admin.id AND access.owner_user_id = ?
        ORDER BY COALESCE((SELECT MAX(message.created_at) FROM platform_messages message WHERE message.thread_id = thread.id), thread.updated_at, admin.created_at) DESC, admin.id DESC`)
      .all(req.adminUser.id).map((thread) => {
        let roles = [];
        try { roles = JSON.parse(thread.adminRolesJson || '[]'); } catch { roles = []; }
        delete thread.adminRolesJson;
        if (thread.adminRole === 'platform_owner' && !roles.includes('platform_owner')) roles.unshift('platform_owner');
        delete thread.adminRole;
        return { ...thread, adminRoles: Array.isArray(roles) && roles.length ? roles : ['portfolio_owner'], replyAllowed: Boolean(thread.replyAllowed) };
      })
    : database.prepare(`SELECT thread.id, thread.admin_user_id AS adminId, admin.display_name AS adminName, admin.email AS adminEmail,
        admin.status AS adminStatus, admin.roles_json AS adminRolesJson, thread.reply_allowed AS replyAllowed, thread.updated_at AS updatedAt,
        (SELECT MAX(message.created_at) FROM platform_messages message WHERE message.thread_id = thread.id) AS latestMessageAt
        FROM admin_users admin LEFT JOIN platform_message_threads thread ON thread.admin_user_id = admin.id
        WHERE admin.id = ?`).all(req.adminUser.id).map((thread) => {
        let roles = [];
        try { roles = JSON.parse(thread.adminRolesJson || '[]'); } catch { roles = []; }
        delete thread.adminRolesJson;
        return { ...thread, adminRoles: Array.isArray(roles) && roles.length ? roles : [req.adminUser.role], replyAllowed: thread.id ? Boolean(thread.replyAllowed) : true };
      });

  database.prepare(`INSERT OR IGNORE INTO platform_message_deliveries (message_id, recipient_id)
    SELECT message.id, ? FROM platform_messages message
    JOIN platform_message_threads thread ON thread.id = message.thread_id
    WHERE message.deleted_at IS NULL AND message.sender_id <> ?
      AND COALESCE(message.recipient_owner_id, thread.admin_user_id) = ?`).run(req.adminUser.id, req.adminUser.id, req.adminUser.id);

  const rows = owner && !adminWorkspace
    ? database.prepare(`SELECT message.id, message.thread_id AS threadId, message.sender_id AS senderId, sender.display_name AS senderName,
        sender.email AS senderEmail, sender.role AS senderRole, owner.display_name AS recipientOwnerName, message.recipient_owner_id AS recipientOwnerId, message.body, message.created_at AS createdAt, message.deleted_at AS deletedAt, message.edited_at AS editedAt, message.message_group_id AS messageGroupId, message.message_group_label AS messageGroupLabel, message.reply_allowed AS replyAllowed, message.reply_to_message_id AS replyToMessageId,
        EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?) AS isRead,
        EXISTS (SELECT 1 FROM platform_message_deliveries delivery WHERE delivery.message_id = message.id AND delivery.recipient_id = COALESCE(message.recipient_owner_id, thread.admin_user_id)) AS isDelivered,
        0 AS isHidden
        FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        LEFT JOIN admin_users sender ON sender.id = message.sender_id LEFT JOIN admin_users owner ON owner.id = message.recipient_owner_id ORDER BY message.created_at, message.id`).all(req.adminUser.id)
    : adminWorkspace
      ? database.prepare(`SELECT message.id, message.thread_id AS threadId, message.sender_id AS senderId, sender.display_name AS senderName,
        sender.email AS senderEmail, sender.role AS senderRole, owner.display_name AS recipientOwnerName, message.recipient_owner_id AS recipientOwnerId, message.body, message.created_at AS createdAt, message.deleted_at AS deletedAt, message.edited_at AS editedAt, message.message_group_id AS messageGroupId, message.message_group_label AS messageGroupLabel, message.reply_allowed AS replyAllowed, message.reply_to_message_id AS replyToMessageId,
        EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?) AS isRead,
        EXISTS (SELECT 1 FROM platform_message_deliveries delivery WHERE delivery.message_id = message.id AND delivery.recipient_id = COALESCE(message.recipient_owner_id, thread.admin_user_id)) AS isDelivered,
        EXISTS (SELECT 1 FROM platform_message_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?) AS isHidden
        FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        LEFT JOIN admin_users sender ON sender.id = message.sender_id LEFT JOIN admin_users owner ON owner.id = message.recipient_owner_id
        WHERE (thread.admin_user_id = ? OR (sender.role = 'platform_owner' AND message.recipient_owner_id = ?))
          AND NOT EXISTS (SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?)
        ORDER BY message.created_at, message.id`)
        .all(req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id)
      : database.prepare(`SELECT message.id, message.thread_id AS threadId, message.sender_id AS senderId, sender.display_name AS senderName,
        sender.email AS senderEmail, sender.role AS senderRole, owner.display_name AS recipientOwnerName, message.recipient_owner_id AS recipientOwnerId, message.body, message.created_at AS createdAt, message.deleted_at AS deletedAt, message.edited_at AS editedAt, message.message_group_id AS messageGroupId, message.message_group_label AS messageGroupLabel, message.reply_allowed AS replyAllowed, message.reply_to_message_id AS replyToMessageId,
        EXISTS (SELECT 1 FROM platform_message_reads state WHERE state.message_id = message.id AND state.reader_id = ?) AS isRead,
        EXISTS (SELECT 1 FROM platform_message_deliveries delivery WHERE delivery.message_id = message.id AND delivery.recipient_id = COALESCE(message.recipient_owner_id, thread.admin_user_id)) AS isDelivered,
        EXISTS (SELECT 1 FROM platform_message_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?) AS isHidden
        FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        LEFT JOIN admin_users sender ON sender.id = message.sender_id LEFT JOIN admin_users owner ON owner.id = message.recipient_owner_id WHERE thread.admin_user_id = ?
          AND NOT EXISTS (SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?) ORDER BY message.created_at, message.id`)
      .all(req.adminUser.id, req.adminUser.id, req.adminUser.id, req.adminUser.id);

  return res.json({ success: true, threads, messages: attachmentRowsForMessages(rows), unreadCount: unreadCount(req.adminUser) });
});

router.post('/threads/:threadId/read', (req, res) => {
  const adminWorkspace = isAdminWorkspace(req);
  const threadId = Number(req.params.threadId);
  if (!Number.isSafeInteger(threadId) || threadId < 1) return res.status(400).json({ success: false, error: 'Choose a valid conversation.' });
  const thread = database.prepare('SELECT id, admin_user_id AS adminId FROM platform_message_threads WHERE id = ?').get(threadId);
  const incomingOwnerThread = adminWorkspace && thread && database.prepare(`SELECT 1 FROM platform_messages message
    JOIN admin_users sender ON sender.id = message.sender_id
    WHERE message.thread_id = ? AND message.recipient_owner_id = ? AND sender.role = 'platform_owner' LIMIT 1`).get(threadId, req.adminUser.id);
  if (!thread || ((!isPlatformOwner(req.adminUser) || adminWorkspace) && Number(thread.adminId) !== Number(req.adminUser.id) && !incomingOwnerThread)) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }
  let senderId = null;
  if ((!isPlatformOwner(req.adminUser) || adminWorkspace) && req.body?.senderId !== undefined) {
    senderId = Number(req.body.senderId);
    if (!Number.isSafeInteger(senderId) || senderId < 1) return res.status(400).json({ success: false, error: 'Choose a valid super-admin conversation.' });
    const sender = database.prepare("SELECT id FROM admin_users WHERE id = ? AND role = 'platform_owner'").get(senderId);
    if (!sender) return res.status(404).json({ success: false, error: 'Super-admin conversation not found.' });
  }
  const incoming = isPlatformOwner(req.adminUser) && !adminWorkspace
    ? "sender.role <> 'platform_owner'"
    : adminWorkspace
      ? `sender.role = 'platform_owner' AND sender.id <> ${Number(req.adminUser.id)} AND (thread.admin_user_id = ${Number(req.adminUser.id)} OR message.recipient_owner_id = ${Number(req.adminUser.id)})`
      : 'sender.role = \'platform_owner\'';
  const senderFilter = senderId === null ? '' : ' AND sender.id = ?';
  database.prepare(`INSERT OR IGNORE INTO platform_message_reads (message_id, reader_id)
    SELECT message.id, ? FROM platform_messages message JOIN admin_users sender ON sender.id = message.sender_id
    LEFT JOIN platform_message_threads thread ON thread.id = message.thread_id
    WHERE message.thread_id = ? AND message.deleted_at IS NULL AND ${incoming}${senderFilter}
      AND NOT EXISTS (SELECT 1 FROM platform_message_permanent_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?)`)
    .run(req.adminUser.id, threadId, ...(senderId === null ? [] : [senderId]), req.adminUser.id);
  return res.json({ success: true, unreadCount: unreadCount(req.adminUser) });
});

router.patch('/threads/replies/bulk', (req, res) => {
  if (!isPlatformOwner(req.adminUser)) return res.status(403).json({ success: false, error: 'Only a super-admin can change reply access.' });
  if (typeof req.body?.allowed !== 'boolean') return res.status(400).json({ success: false, error: 'Choose whether replies should be allowed.' });
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  const ids = Array.isArray(req.body?.adminIds) ? [...new Set(req.body.adminIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
  if (Boolean(role) === Boolean(ids.length)) return res.status(400).json({ success: false, error: 'Choose either a role or one or more admins.' });
  const admins = role
    ? database.prepare('SELECT id, roles_json AS rolesJson FROM admin_users WHERE id <> ?').all(req.adminUser.id).filter((admin) => {
      try { return JSON.parse(admin.rolesJson || '[]').includes(role); } catch { return false; }
    })
    : database.prepare(`SELECT id, roles_json AS rolesJson FROM admin_users WHERE id IN (${ids.map(() => '?').join(',')}) AND id <> ?`).all(...ids, req.adminUser.id);
  if (!admins.length) return res.status(404).json({ success: false, error: 'No matching admins were found.' });
  const changed = database.transaction(() => {
    admins.forEach((admin) => {
      database.prepare(`INSERT INTO platform_message_owner_reply_access (admin_user_id, owner_user_id, reply_allowed, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(admin_user_id, owner_user_id) DO UPDATE SET reply_allowed = excluded.reply_allowed, updated_at = CURRENT_TIMESTAMP`)
        .run(admin.id, req.adminUser.id, req.body.allowed ? 1 : 0);
    });
    return admins.length;
  })();
  return res.json({ success: true, updated: changed, message: `Reply access updated for ${changed} admin${changed === 1 ? '' : 's'}.` });
});

router.patch('/threads/:threadId/replies', (req, res) => {
  if (!isPlatformOwner(req.adminUser)) return res.status(403).json({ success: false, error: 'Only a super-admin can change reply access.' });
  const threadId = Number(req.params.threadId);
  if (!Number.isSafeInteger(threadId) || threadId < 1 || typeof req.body?.allowed !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Choose a valid conversation and reply setting.' });
  }
  const thread = database.prepare('SELECT admin_user_id AS adminId FROM platform_message_threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ success: false, error: 'Conversation not found.' });
  database.prepare(`INSERT INTO platform_message_owner_reply_access (admin_user_id, owner_user_id, reply_allowed, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(admin_user_id, owner_user_id) DO UPDATE SET reply_allowed = excluded.reply_allowed, updated_at = CURRENT_TIMESTAMP`)
    .run(thread.adminId, req.adminUser.id, req.body.allowed ? 1 : 0);
  return res.json({ success: true, allowed: req.body.allowed });
});

router.patch('/:messageId', (req, res) => {
  const adminWorkspace = isAdminWorkspace(req);
  const messageId = Number(req.params.messageId);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid message.' });
  if (body.length < 1 || body.length > 3000) return res.status(400).json({ success: false, error: 'Message must be between 1 and 3,000 characters.' });
  if (!isPlatformOwner(req.adminUser) || adminWorkspace) {
    const result = database.prepare(`UPDATE platform_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
      WHERE id = ? AND sender_id = ? AND message_group_id IS NULL AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM platform_message_threads thread WHERE thread.id = platform_messages.thread_id AND thread.admin_user_id = ?)`)
      .run(body, messageId, req.adminUser.id, req.adminUser.id);
    if (!result.changes) return res.status(404).json({ success: false, error: 'Your sent message could not be found.' });
    return res.json({ success: true, message: { id: messageId, body } });
  }
  const result = database.transaction(() => {
    const message = database.prepare(`SELECT id, body, created_at AS createdAt, message_group_id AS messageGroupId FROM platform_messages WHERE id = ? AND sender_id = ?
      AND EXISTS (SELECT 1 FROM admin_users sender WHERE sender.id = platform_messages.sender_id AND sender.role = 'platform_owner')`)
      .get(messageId, req.adminUser.id);
    if (!message) return 0;
    return message.messageGroupId
      ? database.prepare('UPDATE platform_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND message_group_id = ? AND deleted_at IS NULL')
        .run(body, req.adminUser.id, message.messageGroupId).changes
      : database.prepare('UPDATE platform_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? AND sender_id = ? AND deleted_at IS NULL')
        .run(body, message.id, req.adminUser.id).changes;
  })();
  if (!result) return res.status(404).json({ success: false, error: 'Sent message not found.' });
  return res.json({ success: true, message: { id: messageId, body } });
});

router.delete('/bulk-clear', (req, res) => {
  const adminWorkspace = isAdminWorkspace(req);
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
  if (!ids.length || ids.length > (isPlatformOwner(req.adminUser) && !adminWorkspace ? 5000 : 500)) return res.status(400).json({ success: false, error: 'Select a valid number of messages.' });
  if (!isPlatformOwner(req.adminUser) || adminWorkspace) {
    const placeholders = ids.map(() => '?').join(',');
    const selected = database.prepare(`SELECT message.id, message.sender_id AS senderId, message.deleted_at AS deletedAt,
        message.reply_allowed AS messageReplyAllowed, COALESCE(access.reply_allowed, ${adminWorkspace ? 1 : 'thread.reply_allowed'}) AS threadReplyAllowed,
        sender.role AS senderRole,
        EXISTS (SELECT 1 FROM platform_message_hidden hidden WHERE hidden.message_id = message.id AND hidden.admin_user_id = ?) AS isHidden
      FROM platform_messages message
      JOIN platform_message_threads thread ON thread.id = message.thread_id
      JOIN admin_users sender ON sender.id = message.sender_id
      LEFT JOIN platform_message_owner_reply_access access ON access.admin_user_id = ? AND access.owner_user_id = sender.id
      WHERE message.id IN (${placeholders}) AND (thread.admin_user_id = ? OR (sender.role = 'platform_owner' AND message.recipient_owner_id = ?))`).all(req.adminUser.id, req.adminUser.id, ...ids, req.adminUser.id, req.adminUser.id);
    const restrictedIncoming = selected.some((message) => Number(message.senderId) !== Number(req.adminUser.id)
      && message.senderRole === 'platform_owner' && !message.deletedAt && !message.isHidden
      && (!message.messageReplyAllowed || !message.threadReplyAllowed));
    if (restrictedIncoming && req.body?.confirmation !== 'DELETE') {
      return res.status(400).json({ success: false, code: 'CONFIRMATION_REQUIRED', error: 'Type DELETE to clear selected messages that do not allow replies.' });
    }
    const result = database.transaction(() => {
      const clearSent = database.prepare(`UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND sender_id = ? AND message_group_id IS NULL AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM platform_message_threads thread WHERE thread.id = platform_messages.thread_id AND thread.admin_user_id = ?)`);
      const hideReceived = database.prepare(`INSERT OR IGNORE INTO platform_message_hidden (message_id, admin_user_id)
        SELECT message.id, ? FROM platform_messages message JOIN platform_message_threads thread ON thread.id = message.thread_id
        JOIN admin_users sender ON sender.id = message.sender_id
        WHERE message.id = ? AND (thread.admin_user_id = ? OR message.recipient_owner_id = ?) AND sender.role = 'platform_owner' AND message.deleted_at IS NULL`);
      let sent = 0;
      let received = 0;
      selected.forEach((message) => {
        if (message.deletedAt || message.isHidden) return;
        if (Number(message.senderId) === Number(req.adminUser.id)) sent += clearSent.run(message.id, req.adminUser.id, req.adminUser.id).changes;
        else if (message.senderRole === 'platform_owner') received += hideReceived.run(req.adminUser.id, message.id, req.adminUser.id, req.adminUser.id).changes;
      });
      return { sent, received };
    })();
    const cleared = result.sent + result.received;
    return res.json({ success: true, cleared, sent: result.sent, received: result.received,
      message: `${result.sent} sent message${result.sent === 1 ? '' : 's'} cleared and ${result.received} super-admin message${result.received === 1 ? '' : 's'} removed from your inbox.` });
  }
  const result = database.transaction(() => {
    const find = database.prepare(`SELECT id, message_group_id AS messageGroupId FROM platform_messages WHERE id = ? AND sender_id = ?
      AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM admin_users sender WHERE sender.id = platform_messages.sender_id AND sender.role = 'platform_owner')`);
    const deleteGroup = database.prepare('UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND message_group_id = ? AND deleted_at IS NULL');
    const deleteOne = database.prepare('UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND sender_id = ? AND deleted_at IS NULL');
    const groups = new Set();
    let deleted = 0;
    ids.forEach((id) => {
      const message = find.get(id, req.adminUser.id);
      if (!message) return;
      if (message.messageGroupId) {
        if (groups.has(message.messageGroupId)) return;
        groups.add(message.messageGroupId);
        deleted += deleteGroup.run(req.adminUser.id, message.messageGroupId).changes;
      } else deleted += deleteOne.run(message.id, req.adminUser.id).changes;
    });
    return deleted;
  })();
  return res.json({ success: true, cleared: result, message: `${result} message${result === 1 ? '' : 's'} cleared.` });
});

router.delete('/bulk-clear-permanent', async (req, res) => {
  if (!isPlatformOwner(req.adminUser)) return res.status(403).json({ success: false, error: 'Only a super-admin can clear sent messages permanently.' });
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
  if (!ids.length || ids.length > 5000) return res.status(400).json({ success: false, error: 'Select between 1 and 5,000 sent messages.' });
  const count = await clearMessagesPermanently(ids, req.adminUser.id);
  return res.json({ success: true, cleared: count, message: `${count} message${count === 1 ? '' : 's'} cleared permanently.` });
});

router.delete('/:messageId/clear-permanent', async (req, res) => {
  if (!isPlatformOwner(req.adminUser)) return res.status(403).json({ success: false, error: 'Only a super-admin can clear sent messages permanently.' });
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid message.' });
  const count = await clearMessagesPermanently([messageId], req.adminUser.id);
  if (!count) return res.status(404).json({ success: false, error: 'Sent message not found.' });
  return res.json({ success: true, cleared: count, message: 'Message cleared permanently.' });
});

router.delete('/:messageId', (req, res) => {
  const adminWorkspace = isAdminWorkspace(req);
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ success: false, error: 'Choose a valid message.' });
  if (!isPlatformOwner(req.adminUser) || adminWorkspace) {
    const result = database.prepare(`UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND sender_id = ? AND message_group_id IS NULL AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM platform_message_threads thread WHERE thread.id = platform_messages.thread_id AND thread.admin_user_id = ?)`)
      .run(messageId, req.adminUser.id, req.adminUser.id);
    if (result.changes) return res.json({ success: true, message: 'Sent message cleared.' });
    const incoming = database.prepare(`SELECT message.id, message.reply_allowed AS replyAllowed,
        COALESCE(access.reply_allowed, ${adminWorkspace ? 1 : 'thread.reply_allowed'}) AS threadReplyAllowed FROM platform_messages message
      JOIN platform_message_threads thread ON thread.id = message.thread_id
      JOIN admin_users sender ON sender.id = message.sender_id
      LEFT JOIN platform_message_owner_reply_access access ON access.admin_user_id = ? AND access.owner_user_id = sender.id
      WHERE message.id = ? AND (thread.admin_user_id = ? OR message.recipient_owner_id = ?) AND sender.role = 'platform_owner'
        AND message.deleted_at IS NULL`)
      .get(req.adminUser.id, messageId, req.adminUser.id, req.adminUser.id);
    if (!incoming) return res.status(404).json({ success: false, error: 'This message cannot be removed from your inbox.' });
    const alreadyHidden = database.prepare('SELECT 1 FROM platform_message_hidden WHERE message_id = ? AND admin_user_id = ?').get(messageId, req.adminUser.id);
    if (alreadyHidden) {
      database.prepare('INSERT OR IGNORE INTO platform_message_permanent_hidden (message_id, admin_user_id) VALUES (?, ?)').run(messageId, req.adminUser.id);
      return res.json({ success: true, permanentlyDeleted: true, message: 'Message permanently removed from your inbox.' });
    }
    const repliesDisabled = !incoming.replyAllowed || !incoming.threadReplyAllowed;
    if (repliesDisabled && req.body?.confirmation !== 'DELETE') {
      return res.status(400).json({ success: false, code: 'CONFIRMATION_REQUIRED', error: 'Type DELETE to remove this message.' });
    }
    database.prepare('INSERT OR IGNORE INTO platform_message_hidden (message_id, admin_user_id) VALUES (?, ?)').run(messageId, req.adminUser.id);
    return res.json({ success: true, cleared: true, message: 'Message cleared from your inbox.' });
  }
  const result = database.transaction(() => {
    const message = database.prepare(`SELECT id, message_group_id AS messageGroupId FROM platform_messages WHERE id = ? AND sender_id = ?
      AND EXISTS (SELECT 1 FROM admin_users sender WHERE sender.id = platform_messages.sender_id AND sender.role = 'platform_owner')`)
      .get(messageId, req.adminUser.id);
    if (!message) return 0;
    return message.messageGroupId
      ? database.prepare('UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND message_group_id = ? AND deleted_at IS NULL')
        .run(req.adminUser.id, message.messageGroupId).changes
      : database.prepare('UPDATE platform_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND sender_id = ? AND deleted_at IS NULL')
        .run(message.id, req.adminUser.id).changes;
  })();
  if (!result) return res.status(404).json({ success: false, error: 'Sent message not found.' });
  return res.json({ success: true, message: 'Sent message cleared.' });
});

router.post('/', (req, res) => {
  const adminWorkspace = isAdminWorkspace(req);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const attachmentIds = Array.isArray(req.body?.attachmentIds) ? [...new Set(req.body.attachmentIds.filter((id) => typeof id === 'string' && id.length <= 64))] : [];
  if (body.length > 3000 || (!body && !attachmentIds.length)) return res.status(400).json({ success: false, error: 'Enter a message or attach a file. Message text can be up to 3,000 characters.' });
  if (attachmentIds.length > 10) return res.status(400).json({ success: false, error: 'Attach up to 10 files to one message.' });
  const uploadedAttachments = attachmentIds.length
    ? database.prepare(`SELECT id, size_bytes AS size FROM platform_message_attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})
        AND uploaded_by_id = ? AND message_id IS NULL AND message_group_id IS NULL`).all(...attachmentIds, req.adminUser.id)
    : [];
  if (uploadedAttachments.length !== attachmentIds.length) return res.status(400).json({ success: false, error: 'One or more attachments are invalid or already used.' });
  if (uploadedAttachments.reduce((sum, attachment) => sum + attachment.size, 0) > MESSAGE_TOTAL_ATTACHMENT_LIMIT) return res.status(413).json({ success: false, error: 'Attachments together must be 100 MB or smaller.' });
  const owner = isPlatformOwner(req.adminUser);

  if (!owner || adminWorkspace) {
    const thread = ensureThread(req.adminUser.id);
    const selectedOwnerId = req.body?.recipientOwnerId === undefined ? null : Number(req.body.recipientOwnerId);
    if (selectedOwnerId !== null && (!Number.isSafeInteger(selectedOwnerId) || selectedOwnerId < 1)) return res.status(400).json({ success: false, error: 'Choose a valid super-admin contact.' });
    const recipientOwner = selectedOwnerId === null
      ? database.prepare("SELECT id, display_name AS displayName FROM admin_users WHERE role = 'platform_owner' AND status = 'active' AND id <> ? ORDER BY id LIMIT 1").get(req.adminUser.id)
      : database.prepare("SELECT id, display_name AS displayName FROM admin_users WHERE id = ? AND role = 'platform_owner' AND status = 'active' AND id <> ?").get(selectedOwnerId, req.adminUser.id);
    if (!recipientOwner) return res.status(409).json({ success: false, error: 'There is no active super-admin available to contact.' });
    const access = database.prepare(`SELECT COALESCE(permission.reply_allowed, thread.reply_allowed, 1) AS replyAllowed
      FROM platform_message_threads thread
      LEFT JOIN platform_message_owner_reply_access permission ON permission.admin_user_id = thread.admin_user_id AND permission.owner_user_id = ?
      WHERE thread.id = ?`).get(recipientOwner.id, thread.id);
    if (!access?.replyAllowed) return res.status(403).json({ success: false, code: 'REPLIES_DISABLED', error: 'This super-admin has paused messages from your account.' });
    const requestedReplyId = req.body?.replyToMessageId === undefined || req.body?.replyToMessageId === null ? null : Number(req.body.replyToMessageId);
    let replyTarget = null;
    if (requestedReplyId !== null) {
      if (!Number.isSafeInteger(requestedReplyId) || requestedReplyId < 1) return res.status(400).json({ success: false, error: 'Choose a valid message to reply to.' });
      replyTarget = database.prepare(`SELECT message.id, message.reply_allowed AS replyAllowed, sender.id AS ownerId FROM platform_messages message
        JOIN admin_users sender ON sender.id = message.sender_id
        WHERE message.id = ? AND sender.id = ? AND sender.role = 'platform_owner' AND message.deleted_at IS NULL
          AND (message.thread_id = ? OR message.recipient_owner_id = ?)`).get(requestedReplyId, recipientOwner.id, thread.id, req.adminUser.id);
      if (!replyTarget) return res.status(404).json({ success: false, error: 'The selected message is no longer available to reply to.' });
      if (Number(replyTarget.ownerId) !== Number(recipientOwner.id)) return res.status(400).json({ success: false, error: 'Choose a message from the selected super-admin.' });
    }
    if (replyTarget && !replyTarget.replyAllowed) {
      return res.status(403).json({ success: false, code: 'MESSAGE_REPLIES_DISABLED', error: 'Replies are not allowed to this message.' });
    }
    const result = database.prepare('INSERT INTO platform_messages (thread_id, sender_id, body, reply_to_message_id, recipient_owner_id) VALUES (?, ?, ?, ?, ?)')
      .run(thread.id, req.adminUser.id, body, replyTarget?.id || null, recipientOwner.id);
    if (attachmentIds.length) database.prepare(`UPDATE platform_message_attachments SET message_id = ? WHERE id IN (${attachmentIds.map(() => '?').join(',')}) AND uploaded_by_id = ?`)
      .run(result.lastInsertRowid, ...attachmentIds, req.adminUser.id);
    database.prepare('UPDATE platform_message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
    return res.status(201).json({ success: true, message: { id: result.lastInsertRowid, threadId: thread.id, senderId: req.adminUser.id,
      senderName: req.adminUser.display_name, senderEmail: req.adminUser.email, senderRole: req.adminUser.role, recipientOwnerId: recipientOwner.id, recipientOwnerName: recipientOwner.displayName, body, replyToMessageId: replyTarget?.id || null, createdAt: new Date().toISOString(), isRead: true } });
  }

  const all = req.body?.all === true;
  const replyAllowed = req.body?.allowReplies === undefined ? null : req.body.allowReplies !== false;
  const messageReplyAllowed = req.body?.allowMessageReplies !== false;
  const requestedRole = typeof req.body?.recipientRole === 'string' ? req.body.recipientRole : '';
  const roleLabels = { platform_owner: 'Super admin', portfolio_owner: 'Portfolio owner', content_manager: 'Content manager', document_manager: 'Document manager', download_manager: 'Download manager', profile_manager: 'Profile manager' };
  let recipients;
  if (all) {
    recipients = database.prepare("SELECT id, display_name AS name, email, roles_json AS rolesJson FROM admin_users WHERE id <> ? AND status = 'active' ORDER BY id").all(req.adminUser.id);
  } else {
    const requestedIds = Array.isArray(req.body?.adminIds) ? req.body.adminIds.map(Number) : [Number(req.body?.adminId)];
    const ids = [...new Set(requestedIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length || ids.length > 100) return res.status(400).json({ success: false, error: 'Choose one or more valid admin recipients.' });
    const placeholders = ids.map(() => '?').join(',');
    recipients = database.prepare(`SELECT id, display_name AS name, email, roles_json AS rolesJson FROM admin_users WHERE id IN (${placeholders}) AND id <> ? AND status = 'active'`).all(...ids, req.adminUser.id);
    if (recipients.length !== ids.length) return res.status(400).json({ success: false, error: 'One or more recipients are missing, inactive, or are your own account.' });
    if (requestedRole && !roleLabels[requestedRole]) return res.status(400).json({ success: false, error: 'Choose a valid recipient role.' });
    if (requestedRole && recipients.some((recipient) => {
      let roles = [];
      try { roles = JSON.parse(recipient.rolesJson || '[]'); } catch { roles = []; }
      return !roles.includes(requestedRole);
    })) return res.status(400).json({ success: false, error: 'One or more selected admins do not have the chosen role.' });
  }
  if (!recipients.length) return res.status(409).json({ success: false, error: 'There are no active customer admins to receive this message.' });

  const messageGroupId = randomUUID();
  const groupLabel = all ? 'all' : requestedRole ? roleLabels[requestedRole] : null;
  const created = [];
  const failures = [];
  recipients.forEach((recipient) => {
    try {
      const saved = database.transaction(() => {
        const thread = ensureThread(recipient.id);
        if (replyAllowed !== null) database.prepare(`INSERT INTO platform_message_owner_reply_access (admin_user_id, owner_user_id, reply_allowed, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(admin_user_id, owner_user_id) DO UPDATE SET reply_allowed = excluded.reply_allowed, updated_at = CURRENT_TIMESTAMP`)
          .run(recipient.id, req.adminUser.id, replyAllowed ? 1 : 0);
        const result = database.prepare('INSERT INTO platform_messages (thread_id, sender_id, body, message_group_id, message_group_label, reply_allowed) VALUES (?, ?, ?, ?, ?, ?)')
          .run(thread.id, req.adminUser.id, body, messageGroupId, groupLabel, messageReplyAllowed ? 1 : 0);
        database.prepare('UPDATE platform_message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
        return { id: result.lastInsertRowid, threadId: thread.id, adminId: recipient.id };
      })();
      created.push(saved);
    } catch {
      failures.push({ adminId: recipient.id, name: recipient.name, email: recipient.email, reason: 'Message could not be saved.' });
    }
  });
  if (!created.length) return res.status(500).json({ success: false, error: `Message could not be sent to ${failures.map((item) => item.name || item.email).join(', ')}.` });
  if (attachmentIds.length) database.prepare(`UPDATE platform_message_attachments SET message_group_id = ? WHERE id IN (${attachmentIds.map(() => '?').join(',')}) AND uploaded_by_id = ?`)
    .run(messageGroupId, ...attachmentIds, req.adminUser.id);
  const summary = failures.length
    ? `Sent to ${created.length} of ${recipients.length}; failed for ${failures.map((item) => item.name || item.email).join(', ')}.`
    : `Message sent to ${created.length} admin${created.length === 1 ? '' : 's'}.`;
  return res.status(201).json({ success: true, sent: created.length, requested: recipients.length, failed: failures, messageGroupId, message: summary });
});

export default router;
