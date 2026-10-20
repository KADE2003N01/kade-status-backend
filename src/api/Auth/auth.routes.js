import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import database from '../../database/database.js';
import { defaultHomepageContent } from '../../config/homepage-content.js';
import { clearSessionCookie, hashSessionToken, requireAdmin, SESSION_COOKIE } from '../../verification/admin-auth.js';
import { getMailFromAddress, getTransporter } from '../../config/mailer.js';

const router = express.Router();
const scryptAsync = promisify(scrypt);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const PASSWORD_RESET_DURATION_MS = 30 * 60 * 1000;

function makePasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

async function emailPasswordReset(user) {
  const transporter = getTransporter('otp');
  if (!transporter) throw Object.assign(new Error('Account recovery email is not configured.'), { status: 503 });
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  database.prepare('DELETE FROM admin_password_resets WHERE expires_at <= ?').run(now);
  database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(user.id);
  database.prepare('INSERT INTO admin_password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), user.id, now + PASSWORD_RESET_DURATION_MS, now);
  const frontendUrl = (process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production'
    ? 'https://david-portifolio.onrender.com'
    : 'http://localhost:5173')).split(',')[0].trim().replace(/\/$/, '');
  const resetUrl = `${frontendUrl}/admin-reset-password.html?token=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from: getMailFromAddress('otp'),
      to: user.email,
      subject: 'Reset your portfolio admin password',
      text: `Hi ${user.display_name},\n\nUse this one-time link within 30 minutes to reset your admin password:\n${resetUrl}\n\nIf you did not request this, ignore this email.`
    });
  } catch (error) {
    database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(user.id);
    throw error;
  }
}

function getCookieOptions() {
  const configuredSameSite = (process.env.COOKIE_SAME_SITE || '').toLowerCase();
  const isProduction = process.env.NODE_ENV === 'production';
  // The admin frontend and API are served from different domains (e.g. two
  // separate onrender.com apps), so the session cookie must be SameSite=None
  // in production or browsers will silently drop it after login.
  const sameSite = ['strict', 'lax', 'none'].includes(configuredSameSite)
    ? configuredSameSite
    : (isProduction ? 'none' : 'lax');
  return {
    httpOnly: true,
    secure: sameSite === 'none' || isProduction,
    sameSite,
    path: '/api',
    maxAge: SESSION_DURATION_MS
  };
}

router.post('/login', async (req, res, next) => {
  try {
    if (!database.prepare('SELECT id FROM admin_users LIMIT 1').get()) {
      return res.status(503).json({
        success: false,
        code: 'ADMIN_SETUP_REQUIRED',
        error: 'No admin account exists in this database. From the backend folder, run `npm run admin:add`, then sign in with that account.'
      });
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password || email.length > 254 || password.length > 1024) {
      return res.status(400).json({ success: false, error: 'Enter your email and password.' });
    }

    const user = database.prepare(`
      SELECT id, email, display_name, password_hash
      FROM admin_users
      WHERE email = ?
    `).get(email);

    let isValidPassword = false;
    if (user) {
      const [salt, storedHash] = user.password_hash.split(':');
      const candidate = await scryptAsync(password, salt, 64);
      const expected = Buffer.from(storedHash, 'hex');
      isValidPassword = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    }

    if (!user || !isValidPassword) {
      return res.status(401).json({ success: false, error: 'Email or password is incorrect.' });
    }

    database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    database.prepare(`
      INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionToken(token), user.id, expiresAt, Date.now());

    res.cookie(SESSION_COOKIE, token, getCookieOptions());

    // Remember the most recently signed-in administrator for the public footer.
    try {
      const row = database.prepare('SELECT value_json FROM portfolio_settings WHERE setting_key = ?').get('homepage');
      const content = row ? JSON.parse(row.value_json) : { ...defaultHomepageContent };
      if (content.adminNameCustom !== true) content.adminName = user.display_name;
      database.prepare(`
        INSERT INTO portfolio_settings (setting_key, value_json, updated_at)
        VALUES ('homepage', ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(content), new Date().toISOString());
    } catch (error) {
      console.error('Could not update the last signed-in admin name:', error);
    }

    return res.json({
      success: true,
      user: { email: user.email, displayName: user.display_name },
      // Fallback session token for browsers that block third-party cookies
      // (common on mobile). Harmless when the cookie was saved normally.
      sessionToken: token
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireAdmin, (req, res) => {
  const user = req.adminUser;
  return res.json({
    success: true,
    user: { email: user.email, displayName: user.display_name }
  });
});

router.get('/admin-users', requireAdmin, (req, res, next) => {
  try {
    const admins = database.prepare(`
      SELECT id, display_name AS displayName, phone, email, created_at AS createdAt
      FROM admin_users ORDER BY display_name COLLATE NOCASE
    `).all();
    return res.json({ success: true, admins, count: admins.length });
  } catch (error) {
    return next(error);
  }
});

router.post('/admin-users/:adminId/password-reset', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.adminId);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid admin account.' });
    const user = database.prepare('SELECT id, email, display_name FROM admin_users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, error: 'Admin account not found.' });
    await emailPasswordReset(user);
    return res.json({ success: true, message: `A one-time reset link was sent to ${user.email}.` });
  } catch (error) {
    return next(error);
  }
});

router.post('/password-reset/request', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Enter a valid admin email address.' });
    }
    const user = database.prepare('SELECT id, email, display_name FROM admin_users WHERE email = ?').get(email);
    if (user) await emailPasswordReset(user);
    return res.json({ success: true, message: 'If this email belongs to an admin, a reset link will be sent shortly.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (token.length < 32 || token.length > 128) return res.status(400).json({ success: false, error: 'This reset link is invalid or expired. Request a new one.' });
    if (password.length < 8 || password.length > 1024) return res.status(400).json({ success: false, error: 'Choose a password with at least 8 characters.' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const reset = database.prepare('SELECT user_id FROM admin_password_resets WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now);
    if (!reset) return res.status(410).json({ success: false, error: 'This reset link is invalid or expired. Request a new one.' });
    database.transaction(() => {
      database.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(makePasswordHash(password), reset.user_id);
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(reset.user_id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(reset.user_id);
    })();
    return res.json({ success: true, message: 'Password reset. Sign in with your new password.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  let token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    const header = req.headers?.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7).trim() || null;
  }
  if (token) {
    database.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }
  clearSessionCookie(res);
  return res.json({ success: true });
});

export default router;
