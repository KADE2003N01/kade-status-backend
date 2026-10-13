import { createHash, randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import database from '../../config/database.js';
import { getTransporter } from '../../config/mailer.js';
import { requireAdmin } from '../Auth/auth.routes.js';

const router = express.Router();
const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const privateDocumentsDirectory = path.join(backendDirectory, 'private-documents');
const TOKEN_DURATION_MS = 5 * 60 * 1000;
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAuthorizedDownload(token) {
  if (!token || token.length > 100) return null;
  const accessToken = database.prepare(`
    SELECT download_access_tokens.token_hash, download_access_tokens.download_id,
      portfolio_documents.document_id, portfolio_documents.title, portfolio_documents.filename,
      portfolio_documents.stored_filename
    FROM download_access_tokens
    JOIN download_enquiries ON download_enquiries.id = download_access_tokens.download_id
    JOIN portfolio_documents ON portfolio_documents.document_id = download_enquiries.document_id
    WHERE download_access_tokens.token_hash = ? AND download_access_tokens.expires_at > ?
  `).get(hashToken(token), Date.now());
  if (!accessToken) return null;

  return {
    ...accessToken,
    document: {
      label: accessToken.title,
      filename: accessToken.filename,
      storedName: accessToken.stored_filename
    }
  };
}

router.post('/request', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId : '';
    const storedDocument = database.prepare(`
      SELECT document_id, title, filename, stored_filename
      FROM portfolio_documents WHERE document_id = ?
    `).get(documentId);
    const document = storedDocument ? {
      id: storedDocument.document_id,
      label: storedDocument.title,
      filename: storedDocument.filename,
      storedName: storedDocument.stored_filename
    } : null;

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, error: 'Enter your name (2 to 100 characters).' });
    }
    if ((!email && !phone) || email.length > 254 || phone.length > 30) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address or phone number.' });
    }
    if (email && !validEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    if (phone && !/^[+\d().\-\s]{7,30}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid phone number.' });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ success: false, error: 'Consent is required to continue.' });
    }
    if (!document) {
      return res.status(400).json({ success: false, error: 'Select a valid document.' });
    }

    const filePath = path.join(privateDocumentsDirectory, document.storedName);
    await access(filePath);

    const requestedAt = new Date().toISOString();
    const insertDownload = database.prepare(`
      INSERT INTO download_enquiries (name, email, phone, document_id, document_label, requested_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertToken = database.prepare(`
      INSERT INTO download_access_tokens (token_hash, download_id, expires_at)
      VALUES (?, ?, ?)
    `);
    const createRequest = database.transaction(() => {
      database.prepare('DELETE FROM download_access_tokens WHERE expires_at <= ?').run(Date.now());
      const result = insertDownload.run(name, email || null, phone || null, document.id, document.label, requestedAt);
      const token = randomBytes(32).toString('base64url');
      insertToken.run(hashToken(token), result.lastInsertRowid, Date.now() + TOKEN_DURATION_MS);
      return { id: result.lastInsertRowid, token };
    });
    const downloadRequest = createRequest();

    let notificationSent = false;
    const transporter = process.env.NODE_ENV === 'test' ? null : getTransporter();
    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.EMAIL_USER,
          replyTo: email || undefined,
          subject: `Portfolio download: ${document.label}`,
          text: [
            `A visitor requested ${document.label}.`,
            `Name: ${name}`,
            `Email: ${email || 'Not provided'}`,
            `Phone: ${phone || 'Not provided'}`,
            `Time: ${requestedAt}`,
            `Request ID: ${downloadRequest.id}`
          ].join('\n')
        });
        notificationSent = true;
      } catch (error) {
        console.error(`Download request ${downloadRequest.id} was saved, but email notification failed:`, error);
      }
    }

    return res.status(201).json({
      success: true,
      downloadToken: downloadRequest.token,
      filename: document.filename,
      notificationSent
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/preview', (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const accessToken = getAuthorizedDownload(token);
    if (!accessToken) {
      return res.status(403).json({ success: false, error: 'This preview has expired. Submit your details again.' });
    }

    const filePath = path.join(privateDocumentsDirectory, accessToken.document.storedName);
    res.sendFile(filePath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${accessToken.document.filename}"`
      }
    }, (error) => {
      if (error) {
        if (!res.headersSent) return next(error);
        console.error(`Could not preview download request ${accessToken.download_id}:`, error);
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/file', (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const accessToken = getAuthorizedDownload(token);
    if (!accessToken) {
      return res.status(403).json({ success: false, error: 'This download link has expired. Submit your details again.' });
    }

    const filePath = path.join(privateDocumentsDirectory, accessToken.document.storedName);
    res.download(filePath, accessToken.document.filename, (error) => {
      if (error) {
        if (!res.headersSent) return next(error);
        console.error(`Could not deliver download request ${accessToken.download_id}:`, error);
        return;
      }
      const downloadedAt = new Date().toISOString();
      database.prepare('UPDATE download_enquiries SET downloaded_at = ? WHERE id = ?')
        .run(downloadedAt, accessToken.download_id);
      database.prepare('DELETE FROM download_access_tokens WHERE token_hash = ?').run(accessToken.token_hash);
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireAdmin, (req, res, next) => {
  try {
    const downloads = database.prepare(`
      SELECT id, name, email, phone, document_id AS documentId,
        document_label AS document, requested_at AS requestedAt, downloaded_at AS downloadedAt
      FROM download_enquiries
      ORDER BY requested_at DESC, id DESC
      LIMIT 500
    `).all();
    return res.json({ success: true, downloads });
  } catch (error) {
    return next(error);
  }
});

export default router;
