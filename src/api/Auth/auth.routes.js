import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import database from '../../database/database.js';
import { defaultHomepageContent } from '../../config/homepage-content.js';
import { clearSessionCookie, hashSessionToken, requireAdmin, SESSION_COOKIE } from '../../verification/admin-auth.js';

const router = express.Router();
const scryptAsync = promisify(scrypt);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

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
