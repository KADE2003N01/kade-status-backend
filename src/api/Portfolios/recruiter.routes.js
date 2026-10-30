import { randomBytes } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import database from '../../database/database.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';
import { validateRequest } from '../../middleware/validate-request.js';
import {
  createRecruiterCode,
  encryptPrivateField,
  hashRecruiterCode,
  hashRecruiterEmail,
  hashRecruiterSession,
  isRecruiterCodeValid,
  RECRUITER_SESSION_COOKIE,
  RECRUITER_SESSION_DURATION_MS
} from '../../services/platform-privacy.js';

const router = express.Router();
const emptyObject = z.object({});
const slug = z.string().toLowerCase().min(3).max(48).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const email = z.string().trim().toLowerCase().email().max(254);
const requestSchema = (body) => z.object({ body, params: z.object({ slug }), query: emptyObject });
const otpRequestSchema = requestSchema(z.object({ email }));
const otpVerifySchema = requestSchema(z.object({
  email,
  code: z.string().regex(/^\d{6}$/)
}));
const contactSchema = requestSchema(z.object({
  name: z.string().trim().min(1).max(120),
  email,
  position: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30)
    .refine((value) => /^[+()\d.\-\s]+$/.test(value) && (value.match(/\d/g) || []).length >= 7 && (value.match(/\d/g) || []).length <= 15),
  reason: z.string().trim().min(1).max(2000),
  consent: z.literal(true)
}));
const recruiterRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    error: 'Too many recruiter access requests. Please try again later.'
  })
});

function findPublishedPortfolio(portfolioSlug) {
  return database.prepare(`
    SELECT id, owner_user_id AS ownerUserId
    FROM portfolios WHERE slug = ? COLLATE NOCASE AND status = 'published'
  `).get(portfolioSlug);
}

function setRecruiterCookie(res, token) {
  res.cookie(RECRUITER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/public',
    maxAge: RECRUITER_SESSION_DURATION_MS
  });
}

router.post('/:slug/recruiter/request-otp', recruiterRateLimit, validateRequest(otpRequestSchema), async (req, res, next) => {
  try {
    const portfolio = findPublishedPortfolio(req.validated.params.slug);
    if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
    const transporter = getTransporter();
    if (!transporter) {
      return res.status(503).json({ success: false, error: 'Recruiter verification email is not configured.' });
    }

    const normalizedEmail = req.validated.body.email;
    const emailHash = hashRecruiterEmail(normalizedEmail);
    const now = Date.now();
    const existing = database.prepare(`
      SELECT requests, request_window_started_at AS windowStartedAt, locked_until AS lockedUntil
      FROM recruiter_otps WHERE portfolio_id = ? AND email_hash = ?
    `).get(portfolio.id, emailHash);
    if (existing?.lockedUntil && existing.lockedUntil > now) {
      return res.status(429).json({ success: false, error: 'Too many incorrect codes. Request another code later.' });
    }
    const withinWindow = existing && now - existing.windowStartedAt < 15 * 60 * 1000;
    if (withinWindow && existing.requests >= 3) {
      return res.status(429).json({ success: false, error: 'Too many codes requested. Try again in 15 minutes.' });
    }

    const code = createRecruiterCode();
    const nextCount = withinWindow ? existing.requests + 1 : 1;
    const startedAt = withinWindow ? existing.windowStartedAt : now;
    const codeHash = hashRecruiterCode(portfolio.id, emailHash, code).toString('hex');
    database.prepare(`
      INSERT INTO recruiter_otps (
        portfolio_id, email_hash, code_hash, expires_at, attempts, locked_until,
        requests, request_window_started_at, created_at
      ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)
      ON CONFLICT (portfolio_id, email_hash) DO UPDATE SET
        code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        attempts = 0, locked_until = NULL, requests = excluded.requests,
        request_window_started_at = excluded.request_window_started_at,
        created_at = excluded.created_at
    `).run(portfolio.id, emailHash, codeHash, now + 10 * 60 * 1000, nextCount, startedAt, now);

    try {
      await transporter.sendMail({
        from: getMailFromAddress(),
        to: normalizedEmail,
        subject: 'Your Digital Status access code',
        text: `Your verification code is ${code}. It expires in 10 minutes.`
      });
    } catch (error) {
      database.prepare(`
        UPDATE recruiter_otps SET code_hash = 'delivery_failed', expires_at = ?
        WHERE portfolio_id = ? AND email_hash = ? AND code_hash = ?
      `).run(Date.now(), portfolio.id, emailHash, codeHash);
      throw error;
    }
    return res.json({ success: true, message: 'A verification code has been sent to your email.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/:slug/recruiter/verify-otp', recruiterRateLimit, validateRequest(otpVerifySchema), (req, res) => {
  const portfolio = findPublishedPortfolio(req.validated.params.slug);
  if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  const emailHash = hashRecruiterEmail(req.validated.body.email);
  const challenge = database.prepare(`
    SELECT code_hash AS codeHash, expires_at AS expiresAt, attempts, locked_until AS lockedUntil
    FROM recruiter_otps WHERE portfolio_id = ? AND email_hash = ?
  `).get(portfolio.id, emailHash);
  const now = Date.now();
  if (!challenge || challenge.expiresAt <= now) {
    return res.status(400).json({ success: false, error: 'This code is invalid or expired. Request a new one.' });
  }
  if (challenge.lockedUntil && challenge.lockedUntil > now) {
    return res.status(429).json({ success: false, error: 'Too many incorrect codes. Request another code later.' });
  }
  if (!isRecruiterCodeValid(portfolio.id, emailHash, req.validated.body.code, challenge.codeHash)) {
    const attempts = challenge.attempts + 1;
    database.prepare(`
      UPDATE recruiter_otps SET attempts = ?, locked_until = ? WHERE portfolio_id = ? AND email_hash = ?
    `).run(attempts, attempts >= 5 ? now + 15 * 60 * 1000 : null, portfolio.id, emailHash);
    return res.status(attempts >= 5 ? 429 : 400).json({
      success: false,
      error: attempts >= 5 ? 'Too many incorrect codes. Request another code later.' : 'The verification code is incorrect.'
    });
  }

  const token = randomBytes(32).toString('hex');
  database.transaction(() => {
    database.prepare(`
      UPDATE recruiter_otps SET code_hash = 'used', expires_at = ?, attempts = 0, locked_until = NULL
      WHERE portfolio_id = ? AND email_hash = ?
    `).run(now, portfolio.id, emailHash);
    database.prepare(`
      INSERT INTO recruiter_sessions (token_hash, portfolio_id, email_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hashRecruiterSession(token), portfolio.id, emailHash, now + RECRUITER_SESSION_DURATION_MS, now);
  })();
  setRecruiterCookie(res, token);
  return res.json({ success: true, message: 'Email verified. You can now view private portfolio sections.' });
});

router.post('/:slug/recruiter/contact', recruiterRateLimit, validateRequest(contactSchema), (req, res) => {
  const portfolio = findPublishedPortfolio(req.validated.params.slug);
  if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found.' });
  const token = req.cookies?.[RECRUITER_SESSION_COOKIE];
  if (!token) return res.status(403).json({ success: false, error: 'Verify your email before submitting your details.' });
  const emailHash = hashRecruiterEmail(req.validated.body.email);
  const session = database.prepare(`
    SELECT email_hash AS emailHash, state, expires_at AS expiresAt
    FROM recruiter_sessions WHERE token_hash = ? AND portfolio_id = ?
  `).get(hashRecruiterSession(token), portfolio.id);
  if (!session || session.expiresAt <= Date.now() || session.emailHash !== emailHash) {
    return res.status(403).json({ success: false, error: 'Verify the email address used for this access session.' });
  }
  if (session.state === 'contact_completed') {
    return res.status(409).json({ success: false, error: 'Your contact details have already been submitted.' });
  }

  const { name, email: contactEmail, position, phone, reason } = req.validated.body;
  const insertContact = database.transaction(() => {
    database.prepare(`
      INSERT INTO recruiter_contacts (
        owner_user_id, portfolio_id, email_hash, name_enc, email_enc,
        position_enc, phone_enc, reason_enc, consent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      portfolio.ownerUserId,
      portfolio.id,
      emailHash,
      encryptPrivateField(portfolio.ownerUserId, name),
      encryptPrivateField(portfolio.ownerUserId, contactEmail),
      encryptPrivateField(portfolio.ownerUserId, position),
      encryptPrivateField(portfolio.ownerUserId, phone),
      encryptPrivateField(portfolio.ownerUserId, reason)
    );
    database.prepare(`
      UPDATE recruiter_sessions SET state = 'contact_completed', contact_completed_at = ?
      WHERE token_hash = ?
    `).run(Date.now(), hashRecruiterSession(token));
  });
  insertContact();
  return res.json({ success: true, message: 'Your details have been securely shared with the portfolio owner.' });
});

export default router;
