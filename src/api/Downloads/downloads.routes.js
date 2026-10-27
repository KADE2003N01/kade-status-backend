import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import express from 'express';
import database from '../../database/database.js';
import { resolveWritablePath } from '../../config/storage.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';
import { requireAdmin, requireAdminRole } from '../../verification/admin-auth.js';
import { parseInternationalPhone } from '../../utils/international-phone.js';

const router = express.Router();
const TOKEN_DURATION_MS = 5 * 60 * 1000;
const VERIFICATION_DURATION_MS = 10 * 60 * 1000;
const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODE_REQUESTS = 3;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function hashVerificationCode(challengeId, code) {
  return scryptSync(code, challengeId, 32).toString('hex');
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function logDeliveryFailure(error) {
  const details = {
    code: typeof error?.code === 'string' ? error.code : undefined,
    responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
    statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined,
    command: typeof error?.command === 'string' ? error.command : undefined
  };
  const authenticationRejected = error?.code === 'EAUTH' && error?.responseCode === 535;
  console.error(
    authenticationRejected
      ? 'Email provider rejected SMTP authentication (535). Check EMAIL_USER and use a current Gmail App Password in EMAIL_PASSWORD.'
      : 'Could not deliver a document-request verification email:',
    details
  );
}

function emailDeliveryErrorMessage(error) {
  if (error?.code === 'EAUTH' && error?.responseCode === 535) {
    return 'The email provider rejected the SMTP login. Check EMAIL_USER and use a current Gmail App Password in EMAIL_PASSWORD.';
  }
  if (['EDNS', 'ENOTFOUND', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET'].includes(error?.code)) {
    return 'The server could not connect to the email provider. Check the backend network connection and try again.';
  }
  if (Number.isInteger(error?.responseCode) && error.responseCode >= 500) {
    return `The email provider refused the message (SMTP ${error.responseCode}). Check the sending account and recipient address.`;
  }
  return `Email delivery failed${error?.code ? ` (${error.code})` : ''}. Check the backend log and try again.`;
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

function consumeAuthorizedPreview(token) {
  if (!token || token.length > 100) return null;
  const tokenHash = hashToken(token);
  return database.transaction(() => {
    const accessToken = database.prepare(`
      SELECT document_preview_tokens.token_hash, portfolio_documents.document_id,
        portfolio_documents.title, portfolio_documents.filename,
        portfolio_documents.stored_filename
      FROM document_preview_tokens
      JOIN portfolio_documents ON portfolio_documents.document_id = document_preview_tokens.document_id
      WHERE document_preview_tokens.token_hash = ? AND document_preview_tokens.expires_at > ?
    `).get(tokenHash, Date.now());
    if (!accessToken) return null;
    const consumed = database.prepare('DELETE FROM document_preview_tokens WHERE token_hash = ?').run(tokenHash);
    return consumed.changes === 1 ? accessToken : null;
  })();
}

router.post('/request', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    // A phone number is optional visitor contact information; verification is email-only.
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId : '';
    const purpose = req.body?.purpose === 'preview' ? 'preview' : 'download';
    const parsedPhone = parseInternationalPhone(phone);
    const verifiedPhone = parsedPhone?.number || '';
    const verifiedEmail = email;
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

    if (purpose !== 'preview' && (name.length < 2 || name.length > 100)) {
      return res.status(400).json({ success: false, error: 'Enter your name (2 to 100 characters).' });
    }
    if (email.length > 254 || !validEmail(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    if (phone && (phone.length > 30 || !parsedPhone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid international phone number with its country calling code.' });
    }
    if (purpose !== 'preview' && (reason.length < 10 || reason.length > 1000)) {
      return res.status(400).json({ success: false, error: 'Describe why you need the document (10 to 1,000 characters).' });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ success: false, error: 'Consent is required to continue.' });
    }
    if (!document) {
      return res.status(400).json({ success: false, error: 'Select a valid document.' });
    }

    await access(resolveWritablePath('private-documents',  document.storedName));
    const transporter = process.env.NODE_ENV !== 'test' ? getTransporter() : null;
    if (process.env.NODE_ENV !== 'test' && !transporter) {
      return res.status(503).json({
        success: false,
        error: 'Email code delivery is not configured. Set EMAIL_USER and EMAIL_PASSWORD on the backend, then restart it.'
      });
    }

    const now = Date.now();
    const ipAddress = req.ip || 'unknown';
    const recipient = email;
    const emailHash = hashToken(`email:${recipient}`);
    const challengeId = randomUUID();
    const code = process.env.NODE_ENV === 'test' && process.env.DOWNLOAD_VERIFICATION_TEST_CODE
      ? process.env.DOWNLOAD_VERIFICATION_TEST_CODE
      : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const reserveChallenge = database.transaction(() => {
      const limit = database.prepare(`
        SELECT attempts, window_started_at AS windowStartedAt
        FROM download_verification_limits WHERE email_hash = ? AND ip_address = ?
      `).get(emailHash, ipAddress);
      if (limit && now - limit.windowStartedAt < VERIFICATION_WINDOW_MS && limit.attempts >= MAX_CODE_REQUESTS) {
        return null;
      }

      const resetWindow = !limit || now - limit.windowStartedAt >= VERIFICATION_WINDOW_MS;
      const windowStartedAt = resetWindow ? now : limit.windowStartedAt;
      if (resetWindow) {
        database.prepare(`
          INSERT INTO download_verification_limits (email_hash, ip_address, attempts, window_started_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(email_hash, ip_address) DO UPDATE SET
            attempts = 1, window_started_at = excluded.window_started_at
        `).run(emailHash, ipAddress, now);
      } else {
        database.prepare(`
          UPDATE download_verification_limits SET attempts = attempts + 1
          WHERE email_hash = ? AND ip_address = ?
        `).run(emailHash, ipAddress);
      }
      database.prepare('DELETE FROM download_email_verifications WHERE expires_at <= ?').run(now);
      database.prepare('DELETE FROM download_verification_limits WHERE window_started_at < ?')
        .run(now - 24 * 60 * 60 * 1000);
      database.prepare(`
        INSERT INTO download_email_verifications
          (challenge_id, name, email, phone, reason, document_id, document_label, filename,
            purpose, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        challengeId,
        purpose === 'preview' ? '' : name,
        purpose === 'preview' ? '' : verifiedEmail,
        purpose === 'preview' ? null : verifiedPhone,
        purpose === 'preview' ? '' : reason,
        document.id, document.label, document.filename,
        purpose, hashVerificationCode(challengeId, code), now + VERIFICATION_DURATION_MS, now
      );
      return { windowStartedAt };
    });
    const reservation = reserveChallenge();
    if (!reservation) {
      return res.status(429).json({ success: false, error: 'Too many verification codes requested. Please try again in 15 minutes.' });
    }

    const releaseReservation = database.transaction(() => {
      database.prepare('DELETE FROM download_email_verifications WHERE challenge_id = ?').run(challengeId);
      const currentLimit = database.prepare(`
        SELECT attempts, window_started_at AS windowStartedAt
        FROM download_verification_limits WHERE email_hash = ? AND ip_address = ?
      `).get(emailHash, ipAddress);
      if (!currentLimit || currentLimit.windowStartedAt !== reservation.windowStartedAt) return;
      if (currentLimit.attempts <= 1) {
        database.prepare(`
          DELETE FROM download_verification_limits WHERE email_hash = ? AND ip_address = ?
        `).run(emailHash, ipAddress);
      } else {
        database.prepare(`
          UPDATE download_verification_limits SET attempts = attempts - 1
          WHERE email_hash = ? AND ip_address = ? AND window_started_at = ?
        `).run(emailHash, ipAddress, reservation.windowStartedAt);
      }
    });

    if (process.env.NODE_ENV !== 'test') {
      try {
        await transporter.sendMail({
          from: getMailFromAddress(),
          to: email,
          subject: `Your verification code for ${document.label}`,
          text: `Your document request verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this message.`
        });
      } catch (error) {
        releaseReservation();
        logDeliveryFailure(error);
        return res.status(502).json({
          success: false,
          error: emailDeliveryErrorMessage(error)
        });
      }
    }

    const recipientPreview = email.replace(/^(.).+(@.*)$/, '$1***$2');
    const response = { success: true, challengeId, channel: 'email', recipientPreview, expiresInSeconds: VERIFICATION_DURATION_MS / 1000 };
    if (process.env.NODE_ENV === 'test' && process.env.DOWNLOAD_VERIFICATION_TEST_CODE) {
      response.testVerificationCode = code;
    }
    return res.status(201).json(response);
  } catch (error) {
    return next(error);
  }
});

router.post('/verify', async (req, res, next) => {
  try {
    const challengeId = typeof req.body?.challengeId === 'string' ? req.body.challengeId : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Enter the six-digit verification code we sent.' });
    }

    const challenge = database.prepare(`
      SELECT challenge_id AS challengeId, name, email, phone, reason,
        document_id AS documentId, document_label AS documentLabel, filename, purpose,
        code_hash AS codeHash, expires_at AS expiresAt, attempts
      FROM download_email_verifications WHERE challenge_id = ?
    `).get(challengeId);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      if (challenge) database.prepare('DELETE FROM download_email_verifications WHERE challenge_id = ?').run(challengeId);
      return res.status(410).json({ success: false, error: 'That verification code has expired. Request a new code.' });
    }
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      return res.status(429).json({ success: false, error: 'Too many incorrect codes. Request a new verification code.' });
    }
    const submittedCodeHash = Buffer.from(hashVerificationCode(challengeId, code), 'hex');
    const storedCodeHash = Buffer.from(challenge.codeHash, 'hex');
    if (submittedCodeHash.length !== storedCodeHash.length || !timingSafeEqual(submittedCodeHash, storedCodeHash)) {
      const attempts = challenge.attempts + 1;
      database.prepare('UPDATE download_email_verifications SET attempts = ? WHERE challenge_id = ?')
        .run(attempts, challengeId);
      return res.status(attempts >= MAX_CODE_ATTEMPTS ? 429 : 400).json({
        success: false,
        error: attempts >= MAX_CODE_ATTEMPTS
          ? 'Too many incorrect codes. Request a new verification code.'
          : 'That code is incorrect. Check your email and try again.'
      });
    }

    const document = database.prepare(`
      SELECT document_id, title, filename, stored_filename
      FROM portfolio_documents WHERE document_id = ?
    `).get(challenge.documentId);
    if (!document) {
      database.prepare('DELETE FROM download_email_verifications WHERE challenge_id = ?').run(challengeId);
      return res.status(410).json({ success: false, error: 'This document is no longer available.' });
    }
    await access(resolveWritablePath('private-documents',  document.stored_filename));

    const token = randomBytes(32).toString('base64url');
    const requestedAt = new Date().toISOString();
    const completeVerification = database.transaction(() => {
      const consumed = database.prepare(`
        DELETE FROM download_email_verifications
        WHERE challenge_id = ? AND code_hash = ? AND expires_at > ? AND attempts < ?
      `).run(challengeId, challenge.codeHash, Date.now(), MAX_CODE_ATTEMPTS);
      if (consumed.changes !== 1) return null;
      if (challenge.purpose === 'preview') {
        database.prepare('DELETE FROM document_preview_tokens WHERE expires_at <= ?').run(Date.now());
        database.prepare(`
          INSERT INTO document_preview_tokens (token_hash, document_id, expires_at) VALUES (?, ?, ?)
        `).run(hashToken(token), challenge.documentId, Date.now() + TOKEN_DURATION_MS);
        return true;
      }
      const result = database.prepare(`
        INSERT INTO download_enquiries
          (name, email, phone, reason, document_id, document_label, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        challenge.name, challenge.email || null, challenge.phone, challenge.reason,
        challenge.documentId, challenge.documentLabel, requestedAt
      );
      database.prepare('DELETE FROM download_access_tokens WHERE expires_at <= ?').run(Date.now());
      database.prepare(`
        INSERT INTO download_access_tokens (token_hash, download_id, expires_at) VALUES (?, ?, ?)
      `).run(hashToken(token), result.lastInsertRowid, Date.now() + TOKEN_DURATION_MS);
      return result.lastInsertRowid;
    });
    const downloadId = completeVerification();
    if (challenge.purpose !== 'preview' && !downloadId) {
      return res.status(410).json({ success: false, error: 'That verification code is no longer valid. Request a new code.' });
    }

    if (challenge.purpose === 'preview') {
      if (downloadId !== true) {
        return res.status(410).json({ success: false, error: 'That verification code is no longer valid. Request a new code.' });
      }
      return res.status(201).json({ success: true, downloadToken: token, filename: document.filename });
    }

    let notificationSent = false;
    const transporter = process.env.NODE_ENV === 'test' ? null : getTransporter();
    if (transporter) {
      try {
        await transporter.sendMail({
          from: getMailFromAddress(),
          to: process.env.EMAIL_USER,
          ...(challenge.email ? { replyTo: challenge.email } : {}),
          subject: `Portfolio download: ${challenge.documentLabel}`,
          text: [
            `A visitor requested ${challenge.documentLabel}.`,
            `Name: ${challenge.name}`,
            `Email: ${challenge.email}`,
            `Phone: ${challenge.phone || 'Not provided'}`,
            `Purpose: ${challenge.reason}`,
            `Time: ${requestedAt}`,
            `Request ID: ${downloadId}`
          ].join('\n')
        });
        notificationSent = true;
      } catch (error) {
        console.error(`Verified download request ${downloadId} was saved, but admin notification failed:`, error);
      }
    }

    return res.status(201).json({
      success: true,
      downloadToken: token,
      downloadRequestId: downloadId,
      filename: document.filename,
      notificationSent
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/preview/:documentId', async (req, res, next) => {
  try {
    const document = database.prepare(`
      SELECT title, filename, stored_filename
      FROM portfolio_documents WHERE document_id = ?
    `).get(req.params.documentId);
    if (!document) {
      return res.status(404).json({ success: false, error: 'This document is no longer available.' });
    }

    const filePath = resolveWritablePath('private-documents', document.stored_filename);
    try {
      await access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'This document is no longer available.' });
    }
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.sendFile(filePath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${document.filename}"`
      }
    }, (error) => {
      if (error) {
        if (!res.headersSent) return next(error);
        console.error(`Could not preview public document "${document.title}":`, error);
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/preview', (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const accessToken = consumeAuthorizedPreview(token);
    if (!accessToken) {
      return res.status(403).json({ success: false, error: 'This preview has expired. Submit your details again.' });
    }

    const filePath = resolveWritablePath('private-documents', accessToken.stored_filename);
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.sendFile(filePath, {
      headers: {
        'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${accessToken.filename}"`
      }
    }, (error) => {
      if (error) {
        if (!res.headersSent) return next(error);
        console.error(`Could not serve verified document preview ${accessToken.document_id}:`, error);
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

    const filePath = resolveWritablePath('private-documents',  accessToken.document.storedName);
    res.download(filePath, accessToken.document.filename, (error) => {
      if (error) {
        database.prepare("UPDATE download_enquiries SET download_status = 'failed' WHERE id = ? AND downloaded_at IS NULL")
          .run(accessToken.download_id);
        database.prepare('DELETE FROM download_access_tokens WHERE token_hash = ?').run(accessToken.token_hash);
        if (!res.headersSent) return next(error);
        console.error(`Could not deliver download request ${accessToken.download_id}:`, error);
        return;
      }
      const downloadedAt = new Date().toISOString();
      database.prepare("UPDATE download_enquiries SET downloaded_at = ?, download_status = 'downloaded' WHERE id = ?")
        .run(downloadedAt, accessToken.download_id);
      database.prepare('DELETE FROM download_access_tokens WHERE token_hash = ?').run(accessToken.token_hash);
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/file-failed', (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const accessToken = getAuthorizedDownload(token);
    if (!accessToken) return res.status(410).json({ success: false, error: 'The download attempt has expired.' });
    database.prepare("UPDATE download_enquiries SET download_status = 'failed' WHERE id = ? AND downloaded_at IS NULL")
      .run(accessToken.download_id);
    database.prepare('DELETE FROM download_access_tokens WHERE token_hash = ?').run(accessToken.token_hash);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

router.get('/', requireAdmin, requireAdminRole('portfolio_owner', 'download_manager'), (req, res, next) => {
  try {
    const downloads = database.prepare(`
      SELECT download_enquiries.id, name, email, phone, reason,
        download_enquiries.document_id AS documentId,
        download_enquiries.document_label AS document,
        COALESCE(portfolio_documents.document_type,
          CASE WHEN download_enquiries.document_id LIKE 'cv-%' THEN 'cv'
               WHEN download_enquiries.document_id LIKE 'certificate-%' THEN 'certificate'
               ELSE 'document' END) AS documentType,
        requested_at AS requestedAt, downloaded_at AS downloadedAt,
        download_status AS downloadStatus
      FROM download_enquiries
      LEFT JOIN portfolio_documents ON portfolio_documents.document_id = download_enquiries.document_id
      ORDER BY requested_at DESC, id DESC
      LIMIT 500
    `).all();
    return res.json({ success: true, downloads });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:downloadId', requireAdmin, requireAdminRole('portfolio_owner', 'download_manager'), (req, res, next) => {
  try {
    const downloadId = Number(req.params.downloadId);
    if (!Number.isSafeInteger(downloadId) || downloadId < 1) {
      return res.status(400).json({ success: false, error: 'Enter a valid download request ID.' });
    }
    const deleteRequest = database.transaction(() => {
      database.prepare('DELETE FROM download_access_tokens WHERE download_id = ?').run(downloadId);
      return database.prepare('DELETE FROM download_enquiries WHERE id = ?').run(downloadId).changes;
    });
    if (!deleteRequest()) {
      return res.status(404).json({ success: false, error: 'Download request not found.' });
    }
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
