import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import database from '../../database/database.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';
import { validateRequest } from '../../middleware/validate-request.js';
import {
  getPlatformSessionCookieOptions,
  getPlatformSessionUser,
  hashPlatformToken,
  PLATFORM_SESSION_COOKIE,
  PLATFORM_SESSION_DURATION_MS,
  requirePlatformUser
} from '../../verification/platform-auth.js';

const router = express.Router();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12).max(64)
  .refine((password) => Buffer.byteLength(password, 'utf8') <= 72, 'Password must be at most 72 bytes.');
const emptyObject = z.object({});
const requestSchema = (body) => z.object({
  body,
  params: emptyObject,
  query: emptyObject
});
const signupSchema = requestSchema(z.object({
  email: emailSchema,
  displayName: z.string().trim().min(2).max(100),
  password: passwordSchema
}));
const loginSchema = requestSchema(z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024)
}));
const tokenSchema = requestSchema(z.object({
  token: z.string().regex(/^[a-f\d]{64}$/i)
}));
const resetSchema = requestSchema(z.object({
  token: z.string().regex(/^[a-f\d]{64}$/i),
  password: passwordSchema
}));
const emailOnlySchema = requestSchema(z.object({ email: emailSchema }));
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: 'Too many account requests. Please try again later.'
  })
});

function createToken() {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashPlatformToken(token) };
}

function createFrontendLink(page, token) {
  const frontendOrigin = process.env.FRONTEND_URL?.split(',')[0]?.trim();
  if (!frontendOrigin) {
    const error = new Error('FRONTEND_URL must be configured to send account links.');
    error.status = 503;
    throw error;
  }
  const link = new URL(page, `${frontendOrigin}/`);
  link.searchParams.set('token', token);
  return link.toString();
}

function requireMailer() {
  const transporter = getTransporter();
  if (!transporter) {
    const error = new Error('Account email is not configured. Contact the site administrator.');
    error.status = 503;
    throw error;
  }
  return transporter;
}

async function sendAccountEmail(transporter, email, subject, text) {
  await transporter.sendMail({
    from: getMailFromAddress(),
    to: email,
    subject,
    text
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role
  };
}

router.post('/signup', authRateLimit, validateRequest(signupSchema), async (req, res, next) => {
  try {
    const { email, displayName, password } = req.validated.body;
    const transporter = requireMailer();
    const existing = database.prepare('SELECT id, status FROM users WHERE email = ?').get(email);
    if (existing && existing.status !== 'pending_verification') {
      return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = existing?.id ?? database.prepare(`
      INSERT INTO users (email, display_name, password_hash)
      VALUES (?, ?, ?)
    `).run(email, displayName, passwordHash).lastInsertRowid;
    const token = createToken();
    database.transaction(() => {
      if (existing) {
        database.prepare('UPDATE users SET display_name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(displayName, passwordHash, userId);
      }
      database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
      database.prepare(`
        INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(token.tokenHash, userId, Date.now() + 24 * 60 * 60 * 1000, Date.now());
    })();

    const link = createFrontendLink('platform-verify-email.html', token.token);
    await sendAccountEmail(
      transporter,
      email,
      'Verify your Digital Status account',
      `Hello ${displayName},\n\nVerify your email address to activate your account:\n${link}\n\nThis link expires in 24 hours. If you did not request this account, you can ignore this message.`
    );
    return res.status(201).json({
      success: true,
      message: 'Check your email for a verification link.'
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/verify-email', authRateLimit, validateRequest(tokenSchema), (req, res) => {
  const { token } = req.validated.body;
  const verification = database.prepare(`
    SELECT user_id AS userId FROM email_verifications
    WHERE token_hash = ? AND expires_at > ?
  `).get(hashPlatformToken(token), Date.now());
  if (!verification) {
    return res.status(400).json({ success: false, error: 'This verification link is invalid or expired.' });
  }

  database.transaction(() => {
    database.prepare(`
      UPDATE users
      SET status = 'active', email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending_verification'
    `).run(verification.userId);
    database.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(verification.userId);
  })();
  return res.json({ success: true, message: 'Email verified. You can now sign in.' });
});

router.post('/login', authRateLimit, validateRequest(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.validated.body;
    const user = database.prepare(`
      SELECT id, email, display_name, password_hash, role, status, email_verified_at
      FROM users WHERE email = ?
    `).get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, error: 'Email or password is incorrect.' });
    }
    if (user.status === 'pending_verification' || !user.email_verified_at) {
      return res.status(403).json({ success: false, error: 'Verify your email before signing in.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: 'This account is unavailable.' });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + PLATFORM_SESSION_DURATION_MS;
    database.transaction(() => {
      database.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(user.id, Date.now());
      database.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hashPlatformToken(token), user.id, expiresAt, Date.now());
    })();
    res.cookie(PLATFORM_SESSION_COOKIE, token, getPlatformSessionCookieOptions());
    return res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  const user = getPlatformSessionUser(req);
  const token = req.cookies?.[PLATFORM_SESSION_COOKIE];
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashPlatformToken(token));
  const { maxAge, ...cookieOptions } = getPlatformSessionCookieOptions();
  res.clearCookie(PLATFORM_SESSION_COOKIE, cookieOptions);
  return res.json({ success: true, userId: user?.id ?? null });
});

router.post('/forgot-password', authRateLimit, validateRequest(emailOnlySchema), async (req, res, next) => {
  try {
    const transporter = requireMailer();
    const { email } = req.validated.body;
    const user = database.prepare(`
      SELECT id, email, display_name FROM users
      WHERE email = ? AND status = 'active' AND email_verified_at IS NOT NULL
    `).get(email);

    if (user) {
      const token = createToken();
      database.transaction(() => {
        database.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
        database.prepare(`
          INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `).run(token.tokenHash, user.id, Date.now() + 60 * 60 * 1000, Date.now());
      })();
      const link = createFrontendLink('platform-reset-password.html', token.token);
      await sendAccountEmail(
        transporter,
        user.email,
        'Reset your Digital Status password',
        `Hello ${user.display_name},\n\nUse this link to reset your password:\n${link}\n\nThis link expires in one hour. If you did not request a reset, you can ignore this message.`
      );
    }

    return res.json({
      success: true,
      message: 'If an active account uses that email, a password reset link has been sent.'
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/reset-password', authRateLimit, validateRequest(resetSchema), async (req, res, next) => {
  try {
    const { token, password } = req.validated.body;
    const reset = database.prepare(`
      SELECT user_id AS userId FROM password_resets
      WHERE token_hash = ? AND expires_at > ?
    `).get(hashPlatformToken(token), Date.now());
    if (!reset) {
      return res.status(400).json({ success: false, error: 'This password reset link is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    database.transaction(() => {
      database.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(passwordHash, reset.userId);
      database.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.userId);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.userId);
    })();
    return res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requirePlatformUser, (req, res) => {
  return res.json({ success: true, user: publicUser(req.platformUser) });
});

export default router;
