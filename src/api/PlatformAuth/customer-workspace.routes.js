import express from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import database from '../../database/database.js';
import { resolveWritablePath } from '../../config/storage.js';
import { requirePlatformUser } from '../../verification/platform-auth.js';

const router = express.Router();
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
router.use(requirePlatformUser);
router.use((req, res, next) => req.platformUser.role === 'customer'
  ? next() : res.status(403).json({ success: false, error: 'Customer account required.' }));

router.get('/gallery', (req, res) => {
  const files = database.prepare(`SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS size, created_at AS createdAt
    FROM customer_gallery_files WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(req.platformUser.id);
  return res.json({ success: true, files });
});

router.post('/gallery', express.raw({ type: '*/*', limit: MAX_FILE_SIZE }), async (req, res, next) => {
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

router.get('/gallery/:id', (req, res, next) => {
  const file = database.prepare('SELECT stored_name, mime_type, original_name FROM customer_gallery_files WHERE id = ? AND user_id = ?').get(req.params.id, req.platformUser.id);
  if (!file) return res.status(404).json({ success: false, error: 'File not found.' });
  res.type(file.mime_type).setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  return createReadStream(resolveWritablePath('customer-gallery', file.stored_name)).on('error', next).pipe(res);
});

router.delete('/gallery/:id', async (req, res, next) => {
  try {
    const file = database.prepare('SELECT stored_name FROM customer_gallery_files WHERE id = ? AND user_id = ?').get(req.params.id, req.platformUser.id);
    if (!file) return res.status(404).json({ success: false, error: 'File not found.' });
    database.prepare('DELETE FROM customer_gallery_files WHERE id = ? AND user_id = ?').run(req.params.id, req.platformUser.id);
    await unlink(resolveWritablePath('customer-gallery', file.stored_name)).catch(() => {});
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

router.get('/chat', (req, res) => {
  const messages = database.prepare(`SELECT id, sender_role AS senderRole, body, created_at AS createdAt
    FROM customer_support_messages WHERE user_id = ? ORDER BY id`).all(req.platformUser.id);
  database.prepare(`UPDATE customer_support_messages SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND sender_role = 'platform_owner' AND read_at IS NULL`).run(req.platformUser.id);
  return res.json({ success: true, messages });
});

router.post('/chat', (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1 || body.length > 3000) return res.status(400).json({ success: false, error: 'Write a message up to 3,000 characters.' });
  const result = database.prepare(`INSERT INTO customer_support_messages (user_id, sender_role, body) VALUES (?, 'customer', ?)`).run(req.platformUser.id, body);
  const message = database.prepare(`SELECT id, sender_role AS senderRole, body, created_at AS createdAt FROM customer_support_messages WHERE id = ?`).get(result.lastInsertRowid);
  return res.status(201).json({ success: true, message });
});

export default router;
