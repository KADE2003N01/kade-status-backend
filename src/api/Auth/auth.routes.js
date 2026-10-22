import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import database from '../../database/database.js';
import { clearSessionCookie, hashSessionToken, requireAdmin, requireAdminRole, SESSION_COOKIE } from '../../verification/admin-auth.js';
import { sendAdminPasswordLink } from '../../services/admin-password-links.js';

const router = express.Router();
const scryptAsync = promisify(scrypt);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function auditPasswordAction(actorId, targetId, action, details = {}) {
  database.prepare('INSERT INTO platform_admin_audit (actor_id, target_id, action, details_json) VALUES (?, ?, ?, ?)')
    .run(actorId, targetId, action, JSON.stringify(details));
}

function makePasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
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
      SELECT id, email, display_name, password_hash, role, status
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
    if (user.status === 'pending') return res.status(403).json({ success: false, code: 'ADMIN_SETUP_PENDING', error: 'This account is not active yet. Open the setup link sent to your email, or request a new one.' });
    if (user.status === 'inactive') return res.status(403).json({ success: false, code: 'ADMIN_ACCOUNT_INACTIVE', error: 'This administrator account is inactive. Contact the platform owner for access.' });

    database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    database.prepare(`
      INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionToken(token), user.id, expiresAt, Date.now());

    res.cookie(SESSION_COOKIE, token, getCookieOptions());

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
    user: { email: user.email, displayName: user.display_name, role: user.role }
  });
});

router.get('/admin-users', requireAdmin, requireAdminRole('platform_owner'), (req, res, next) => {
  try {
    const admins = database.prepare(`
      SELECT id, display_name AS displayName, phone, email, created_at AS createdAt
      FROM admin_users ORDER BY display_name COLLATE NOCASE
    `).all();
    const recentActivity = database.prepare(`
      SELECT events.id, events.action, events.details_json AS details, events.created_at AS createdAt,
        actor.email AS actorEmail, target.email AS targetEmail
      FROM platform_admin_audit events
      LEFT JOIN admin_users actor ON actor.id = events.actor_id
      LEFT JOIN admin_users target ON target.id = events.target_id
      WHERE events.action IN (
        'admin_setup_link_resent',
        'admin_password_reset_link_sent', 'admin_password_reset_link_failed',
        'admin_password_reset_completed', 'admin_password_reset_sent'
      )
      ORDER BY events.created_at DESC, events.id DESC LIMIT 100
    `).all().map((event) => {
      const details = JSON.parse(event.details || '{}');
      return { ...event, details, targetEmail: event.targetEmail || details.email || null };
    });
    return res.json({ success: true, admins, count: admins.length, recentActivity });
  } catch (error) {
    return next(error);
  }
});

router.post('/admin-users/:adminId/password-reset', requireAdmin, requireAdminRole('platform_owner'), async (req, res, next) => {
  let user = null;
  try {
    const id = Number(req.params.adminId);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid admin account.' });
    user = database.prepare('SELECT id, email, display_name, status FROM admin_users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, error: 'Admin account not found.' });
    if (user.status === 'inactive') return res.status(409).json({ success: false, error: 'Activate this admin before sending a password reset.' });
    await sendAdminPasswordLink(user, { setup: user.status === 'pending', force: true });
    auditPasswordAction(req.adminUser.id, user.id, user.status === 'pending' ? 'admin_setup_link_resent' : 'admin_password_reset_link_sent', { email: user.email });
    return res.json({ success: true, message: user.status === 'pending'
      ? 'A secure account setup link was sent.'
      : 'A one-time password reset link was sent.' });
  } catch (error) {
    if (user) {
      try {
        auditPasswordAction(req.adminUser.id, user.id, 'admin_password_reset_link_failed', {
          email: user.email,
          reason: typeof error.code === 'string' ? error.code.slice(0, 80) : 'delivery_failed'
        });
      } catch (auditError) {
        console.error('Could not record failed admin password-reset activity:', auditError.message);
      }
    }
    return next(error);
  }
});

router.post('/password-reset/validate', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token.length < 32 || token.length > 128) return res.status(410).json({ success: false, valid: false, error: 'This link has expired or already been used. Request a fresh link.' });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const account = database.prepare(`
    SELECT admin_users.status
    FROM admin_password_resets
    JOIN admin_users ON admin_users.id = admin_password_resets.user_id
    WHERE admin_password_resets.token_hash = ? AND admin_password_resets.expires_at > ?
  `).get(tokenHash, Date.now());
  if (!account) return res.status(410).json({ success: false, valid: false, error: 'This link has expired or already been used. Request a fresh link.' });
  return res.json({ success: true, valid: true, purpose: account.status === 'pending' ? 'setup' : 'reset' });
});

function scheduleAccountLink(user, setup) {
  setImmediate(() => {
    sendAdminPasswordLink(user, { setup }).catch((mailError) => {
      console.error(`Could not deliver an admin ${setup ? 'setup' : 'password-reset'} email:`, mailError.message);
    });
  });
}

router.post('/setup-link/request', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Enter a valid admin email address.' });
  }
  const user = database.prepare('SELECT id, email, display_name, status FROM admin_users WHERE email = ?').get(email);
  if (user?.status === 'pending') scheduleAccountLink(user, true);
  return res.json({ success: true, message: 'If this email has a pending administrator invitation, a setup link will be sent shortly.' });
});

router.post('/password-reset/request', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Enter a valid admin email address.' });
  }
  const user = database.prepare('SELECT id, email, display_name, status FROM admin_users WHERE email = ?').get(email);
  if (user?.status === 'active') scheduleAccountLink(user, false);
  return res.json({ success: true, message: 'If this email belongs to an active administrator, a password reset link will be sent shortly.' });
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
    const completed = database.transaction(() => {
      const consumed = database.prepare('DELETE FROM admin_password_resets WHERE token_hash = ? AND expires_at > ?').run(tokenHash, now);
      if (!consumed.changes) return null;
      const user = database.prepare('SELECT id, status FROM admin_users WHERE id = ?').get(reset.user_id);
      if (!user) return null;
      database.prepare("UPDATE admin_users SET password_hash = ?, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?")
        .run(makePasswordHash(password), user.id);
      database.prepare('DELETE FROM admin_password_resets WHERE user_id = ?').run(user.id);
      database.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(user.id);
      auditPasswordAction(user.id, user.id, 'admin_password_reset_completed', { purpose: user.status === 'pending' ? 'setup' : 'reset' });
      return user.status;
    })();
    if (completed === null) return res.status(410).json({ success: false, error: 'This reset link is invalid or expired. Request a new one.' });
    const message = completed === 'pending'
      ? 'Your password is set and your admin account is active. You can now sign in.'
      : completed === 'inactive'
        ? 'Your password was updated, but this admin account is inactive. Contact the platform owner for access.'
        : 'Your password has been updated. Sign in with your new password.';
    return res.json({ success: true, message });
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
